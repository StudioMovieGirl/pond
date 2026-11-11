import { isManualSensitiveDecision } from "@pond/schema/content-safety";
import {
  enrichmentCooldownFactor,
  enrichmentRestMs,
  enrichmentSuspended,
} from "@shared/machine-pace";
import pLimit from "p-limit";
import {
  attachFailurePersistence,
  enrichmentFailures,
} from "@/features/enrichment/state/enrichment-failures";
import {
  type EnrichmentFailure,
  enrichmentMonitor,
} from "@/features/enrichment/state/enrichment-monitor";
import {
  createProgressTracker,
  type ReconcileEntry,
} from "@/features/enrichment/state/progress-tracker";
import { onPoolDirty, pool, upsertSave } from "@/features/saves/pool";
import type { Save } from "@/features/saves/types";
import {
  readMachinePace,
  retainMachinePace,
  subscribeMachinePace,
} from "@/shared/lib/machine-pace";
import { getPrefsSnapshot, subscribePrefsSnapshot } from "@/shared/state/prefs";
import { releaseIdleInferenceWorker } from "./inference-client";
import { ENRICHERS, ENRICHERS_BY_ID } from "./registry";
import type { Enricher } from "./types";

type PrefsSnapshot = ReturnType<typeof getPrefsSnapshot>;

export function createEnrichmentPreferenceAccess(
  getPrefs: () => PrefsSnapshot,
) {
  return {
    eligible(enricher: Enricher, save: Save, prefs = getPrefs()): boolean {
      return enricher.eligible(save, prefs?.ai);
    },
    run(enricher: Enricher, save: Save) {
      return enricher.run(save, getPrefs()?.ai);
    },
  };
}

function mediaUnderstandingPreferenceKey(prefs: PrefsSnapshot): string {
  return JSON.stringify(prefs?.ai ?? null);
}

export function subscribeMediaUnderstandingRefresh(dependencies: {
  getPrefs: () => PrefsSnapshot;
  subscribe: (listener: () => void) => () => void;
  refresh: () => void;
}): () => void {
  let preferenceKey = mediaUnderstandingPreferenceKey(dependencies.getPrefs());
  return dependencies.subscribe(() => {
    const nextKey = mediaUnderstandingPreferenceKey(dependencies.getPrefs());
    if (nextKey === preferenceKey) return;
    preferenceKey = nextKey;
    dependencies.refresh();
  });
}

const enrichmentPreferenceAccess =
  createEnrichmentPreferenceAccess(getPrefsSnapshot);

/** Models are CPU/GPU heavy and share the UI renderer; one-at-a-time keeps the sweep from starving interactive work. */
const limit = pLimit(1);
const inflight = new Set<string>();
const missingDuringSweep = new Set<string>();
const progress = createProgressTracker();
/** The task whose run is executing right now; null between runs. */
let activeTask: string | null = null;
let sessionDone = 0;

export function isMissingMediaFailure(error: Error): boolean {
  if (error.message.startsWith("fetch failed (404)")) return true;
  return (
    error.name === "GemmaMediaUnderstandingError" &&
    error.message.includes("missing")
  );
}

export function saveNeedsEnrichment(
  save: { id: string; status?: string; deletedAt?: number | Date | null },
  missingIds: ReadonlySet<string>,
): boolean {
  if (save.deletedAt != null || save.status !== "complete") return false;
  return !missingIds.has(save.id);
}

function failureRows(): EnrichmentFailure[] {
  return enrichmentFailures.snapshot().map((row) => {
    const index = row.key.indexOf(":");
    return {
      key: row.key,
      saveId: index === -1 ? "" : row.key.slice(index + 1),
      title: row.title,
      task: index === -1 ? "" : row.key.slice(0, index),
      reason: row.reason,
    };
  });
}

export async function refreshMissingOriginals(): Promise<ReadonlySet<string>> {
  const report = await window.pond.query("library.rescan", {});
  const missingOriginals = report.missingFiles;
  const ids = new Set(missingOriginals.map((save) => save.id));
  for (const id of ids) {
    enrichmentFailures.clearForSaves([id]);
    progress.removeSave(id);
  }
  publishActivity();
  return ids;
}

function suspended(): boolean {
  return enrichmentSuspended(readMachinePace(), Date.now());
}

function publishActivity(): void {
  const rows = failureRows();
  enrichmentMonitor.set({
    inflight: inflight.size,
    activeKeys: new Set(inflight),
    activeTask,
    failedKeys: new Set(rows.map((row) => row.key)),
    failures: rows,
    progress: progress.snapshot(inflight),
  });
}

function rememberFailure(key: string, save: Save, reason: string): void {
  enrichmentFailures.remember(key, save.title ?? null, reason);
}

function keyFor(enricher: Enricher, save: Save): string {
  return `${enricher.id}:${save.id}`;
}

/**
 * Rest between runs so the CPU/GPU returns to idle instead of pinning at ~100% for the whole backlog; requestIdleCallback fires immediately on an idle machine, so heavy runs would otherwise go back-to-back.
 * @remarks Rest is ~50% of the run's own duration, clamped so quick runs still pause and long runs don't stall the backlog. Battery, a background window, and fair heat stretch that rest.
 */
function cooldown(lastRunMs: number): Promise<void> {
  if (suspended()) return Promise.resolve();
  const ms = enrichmentRestMs(
    lastRunMs,
    enrichmentCooldownFactor(readMachinePace()),
  );
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function whenIdle(timeout = 2000): Promise<void> {
  return new Promise((resolve) => {
    if (globalThis.requestIdleCallback) {
      globalThis.requestIdleCallback(() => resolve(), { timeout });
    } else setTimeout(resolve, 0);
  });
}

function dependenciesSatisfied(
  enricher: Enricher,
  save: Save,
  prefs: ReturnType<typeof getPrefsSnapshot>,
): boolean {
  if (!enricher.dependsOn) return true;
  for (const depId of enricher.dependsOn) {
    const dep = ENRICHERS_BY_ID.get(depId);
    if (!dep) continue;
    if (
      dep.enabled(prefs) &&
      enrichmentPreferenceAccess.eligible(dep, save, prefs)
    )
      return false;
  }
  return true;
}

async function persist(enricher: Enricher, save: Save): Promise<boolean> {
  const result = await enrichmentPreferenceAccess.run(enricher, save);
  if (result == null) return false;
  const current = pool.get(save.id);
  /** Classification may still be running when the user corrects the Save. */
  if (
    enricher.id === "sensitive-content" &&
    isManualSensitiveDecision(current?.sensitiveModel)
  ) {
    return true;
  }
  if (result.optimistic) {
    if (current) upsertSave({ ...current, ...result.optimistic });
  }
  if (result.derived && Object.keys(result.derived).length > 0) {
    try {
      await window.pond.query("saves.patchDerived", {
        id: save.id,
        patch: result.derived,
      });
    } catch (err) {
      console.warn(`[enrichment] persist failed (${enricher.id})`, err);
    }
  }
  return true;
}

function schedule(enricher: Enricher, save: Save): void {
  if (suspended() || missingDuringSweep.has(save.id)) return;
  const key = keyFor(enricher, save);
  if (inflight.has(key) || enrichmentFailures.has(key)) return;
  inflight.add(key);
  publishActivity();
  void limit(async () => {
    await whenIdle();
    const current = pool.get(save.id);
    const prefs = getPrefsSnapshot();
    if (
      suspended() ||
      missingDuringSweep.has(save.id) ||
      !current ||
      enrichmentFailures.has(key) ||
      !enricher.enabled(prefs) ||
      !enrichmentPreferenceAccess.eligible(enricher, current, prefs) ||
      !dependenciesSatisfied(enricher, current, prefs)
    ) {
      inflight.delete(key);
      publishActivity();
      return;
    }
    const startedAt = performance.now();
    activeTask = enricher.id;
    progress.markStarted(enricher.id, Date.now());
    let elapsed = 0;
    let outcome: "done" | "failed" | "missing" = "done";
    let failureReason: string | null = null;
    try {
      if (!(await persist(enricher, current))) {
        outcome = "failed";
        failureReason = "Couldn't finish";
      }
    } catch (err) {
      if (err instanceof Error && isMissingMediaFailure(err)) {
        outcome = "missing";
        missingDuringSweep.add(save.id);
        const existing = enrichmentMonitor.snapshot().missingOriginals;
        if (!existing.some((item) => item.id === save.id)) {
          enrichmentMonitor.set({
            missingOriginals: [
              ...existing,
              { id: save.id, title: current.title ?? null },
            ],
          });
        }
      } else {
        outcome = "failed";
        failureReason =
          err instanceof Error && err.message ? err.message : "Couldn't finish";
      }
    } finally {
      elapsed = performance.now() - startedAt;
      if (outcome === "failed") {
        rememberFailure(key, current, failureReason ?? "Couldn't finish");
        progress.markFailed(enricher.id, save.id);
        console.warn(
          `[enrichment] ${enricher.id} failed for ${save.id}`,
          failureReason,
        );
      } else if (outcome === "done") {
        sessionDone += 1;
        progress.complete(enricher.id, save.id, elapsed, Date.now());
        if (sessionDone % 10 === 0) {
          const row = progress
            .snapshot(inflight)
            .find((item) => item.task === enricher.id);
          console.info(
            `[enrichment] progress done=${sessionDone} inflight=${inflight.size} ` +
              `last=${enricher.id} (${Math.round(elapsed)}ms)` +
              (row?.avgMs != null ? ` avg=${Math.round(row.avgMs)}ms` : ""),
          );
        }
      }
      /** A missing file leaves both sets until the next missing-file check reconciles it. */
      inflight.delete(key);
      publishActivity();
    }
    await cooldown(elapsed);
  });
}

let mutationGeneration = 0;
let lastFullScanGeneration = -1;

async function scan(
  ids?: readonly string[],
  tasks?: readonly string[],
): Promise<void> {
  if (suspended()) return;
  const prefs = getPrefsSnapshot();
  const scope = ids && ids.length > 0 ? new Set(ids) : null;
  const taskScope = tasks && tasks.length > 0 ? new Set(tasks) : null;
  let missingIds: ReadonlySet<string> = new Set(
    enrichmentMonitor.snapshot().missingOriginals.map((save) => save.id),
  );
  if (!scope) {
    try {
      missingIds = await refreshMissingOriginals();
    } catch (err) {
      console.warn("[enrichment] missing-file check failed", err);
    }
  }
  const saves = [...pool.snapshot()]
    .filter((s) => !scope || scope.has(s.id))
    .filter((s) => saveNeedsEnrichment(s, missingIds))
    .sort((a, b) => b.savedAt - a.savedAt);
  const entries: ReconcileEntry[] = [];
  /** Every task the scan looked at, so a full scan also zeros tasks that turned off. */
  const coveredTasks: string[] = [];
  const backlog: string[] = [];
  for (const enricher of ENRICHERS) {
    if (taskScope && !taskScope.has(enricher.id)) continue;
    coveredTasks.push(enricher.id);
    if (!enricher.enabled(prefs)) continue;
    let eligible = 0;
    for (const save of saves) {
      const isEligible = enrichmentPreferenceAccess.eligible(
        enricher,
        save,
        prefs,
      );
      const isFailed =
        isEligible && enrichmentFailures.has(keyFor(enricher, save));
      entries.push({
        task: enricher.id,
        saveId: save.id,
        pending: isEligible && !isFailed,
        failed: isFailed,
      });
      if (!isEligible || isFailed) continue;
      eligible += 1;
      if (!dependenciesSatisfied(enricher, save, prefs)) continue;
      schedule(enricher, save);
    }
    if (eligible > 0) backlog.push(`${enricher.id}=${eligible}`);
  }
  progress.reconcile(entries, coveredTasks, scope == null);
  if (backlog.length > 0) {
    console.info(
      `[enrichment] scan backlog ${backlog.join(" ")} (inflight=${inflight.size})`,
    );
  }
  publishActivity();
  if (!scope) lastFullScanGeneration = mutationGeneration;
}

let sweepStarted = false;
let scanScheduled = false;
let pendingScope: Set<string> | null = null;
let pendingTasks: Set<string> | null = null;
const FULL_SCAN_MS = 15 * 60_000;

function scheduleScan(
  ids?: readonly string[],
  tasks?: readonly string[],
): void {
  const scoped = ids && ids.length > 0 ? ids : null;
  const scopedTasks = tasks && tasks.length > 0 ? tasks : null;
  if (scanScheduled) {
    if (!scoped) pendingScope = null;
    else if (pendingScope !== null)
      for (const id of scoped) pendingScope.add(id);
    if (!scopedTasks) pendingTasks = null;
    else if (pendingTasks !== null)
      for (const task of scopedTasks) pendingTasks.add(task);
    return;
  }
  scanScheduled = true;
  pendingScope = scoped ? new Set(scoped) : null;
  pendingTasks = scopedTasks ? new Set(scopedTasks) : null;
  setTimeout(() => {
    void whenIdle().then(async () => {
      scanScheduled = false;
      const scope = pendingScope ? [...pendingScope] : undefined;
      const taskScope = pendingTasks ? [...pendingTasks] : undefined;
      pendingScope = null;
      pendingTasks = null;
      await scan(scope, taskScope);
    });
  }, 250);
}

/**
 * A full rescan of every enabled task. Clears the remembered failures, so a
 * Retry button or a settings change re-attempts the saves that gave up.
 */
export function rescanEnrichment(ids?: readonly string[]): void {
  if (ids && ids.length > 0) enrichmentFailures.clearForSaves(ids);
  else enrichmentFailures.clearAll();
  publishActivity();
  scheduleScan(ids);
}

/**
 * Run only the chosen tasks across the whole library. An explicit choice
 * means the user wants these saves attempted, so the tasks' remembered
 * failures are cleared first and the scan is scoped to the chosen tasks.
 */
export function scanLibraryTasks(tasks: readonly string[]): void {
  const selected = [...new Set(tasks)].filter((task) =>
    ENRICHERS_BY_ID.has(task),
  );
  if (selected.length === 0) return;
  enrichmentFailures.clearForTasks(selected);
  publishActivity();
  scheduleScan(undefined, selected);
}

export function startEnrichmentSweep(): () => void {
  if (sweepStarted) return () => {};
  sweepStarted = true;
  attachFailurePersistence();
  const hydrations = ENRICHERS.flatMap((e) =>
    e.hydrate
      ? [
          e.hydrate().catch((err) => {
            console.warn(`[enrichment] hydrate failed (${e.id})`, err);
          }),
        ]
      : [],
  );
  void Promise.all(hydrations).then(() => scheduleScan());
  const detachPrefs = subscribeMediaUnderstandingRefresh({
    getPrefs: getPrefsSnapshot,
    subscribe: subscribePrefsSnapshot,
    refresh: () => rescanEnrichment(),
  });
  const detachDirty = onPoolDirty((ids) => {
    mutationGeneration += 1;
    /** Changed content invalidates remembered failures for those Saves. */
    enrichmentFailures.clearForSaves(ids);
    scheduleScan(ids);
  });
  const fullScanTimer = setInterval(() => {
    if (lastFullScanGeneration !== mutationGeneration) scheduleScan();
  }, FULL_SCAN_MS);

  let wasSuspended = suspended();
  const detachPace = subscribeMachinePace(() => {
    const next = suspended();
    if (next) releaseIdleInferenceWorker();
    if (wasSuspended && !next) scheduleScan();
    wasSuspended = next;
  });
  const releasePace = retainMachinePace();

  return () => {
    detachDirty();
    detachPrefs();
    clearInterval(fullScanTimer);
    detachPace();
    releasePace();
  };
}
