import { z } from "zod";

/**
 * Failed enrichment runs, kept in localStorage so a relaunch does not quietly
 * requeue the same failures. The sweep consults this before scheduling and the
 * Scan Library UI counts these as "failed" instead of "pending".
 */

const FailureSchema = z.object({
  key: z.string(),
  title: z.string().nullable(),
  reason: z.string(),
});
export type EnrichmentFailureRecord = z.infer<typeof FailureSchema>;

const storageKey = "pond:enrichment-failures";
const MAX_RECORDS = 20_000;
const FLUSH_MS = 1_000;

let records: Map<string, EnrichmentFailureRecord> | null = null;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let attached = false;

function load(): Map<string, EnrichmentFailureRecord> {
  if (records) return records;
  const next = new Map<string, EnrichmentFailureRecord>();
  try {
    const parsed = z
      .array(FailureSchema)
      .safeParse(JSON.parse(window.localStorage.getItem(storageKey) ?? "[]"));
    if (parsed.success) {
      for (const row of parsed.data) next.set(row.key, row);
    }
  } catch {
    /** A corrupt record starts clean instead of blocking the sweep. */
  }
  records = next;
  return next;
}

function flush(): void {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
  if (!records) return;
  try {
    window.localStorage.setItem(
      storageKey,
      JSON.stringify([...records.values()]),
    );
  } catch {
    /** Storage can be full or blocked; the in-memory map still holds this session's failures. */
  }
}

function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(flush, FLUSH_MS);
}

function saveIdOf(key: string): string {
  const index = key.indexOf(":");
  return index === -1 ? key : key.slice(index + 1);
}

function taskOf(key: string): string {
  const index = key.indexOf(":");
  return index === -1 ? "" : key.slice(0, index);
}

function prune(map: Map<string, EnrichmentFailureRecord>): void {
  while (map.size > MAX_RECORDS) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) return;
    map.delete(oldest);
  }
}

export const enrichmentFailures = {
  snapshot(): readonly EnrichmentFailureRecord[] {
    return [...load().values()];
  },
  has(key: string): boolean {
    return load().has(key);
  },
  remember(key: string, title: string | null, reason: string): void {
    const map = load();
    map.delete(key);
    map.set(key, { key, title, reason });
    prune(map);
    scheduleFlush();
  },
  /** A Save's content changed, so its failures no longer apply. */
  clearForSaves(ids: readonly string[]): void {
    if (ids.length === 0) return;
    const wanted = new Set(ids);
    const map = load();
    let changed = false;
    for (const key of map.keys()) {
      if (!wanted.has(saveIdOf(key))) continue;
      map.delete(key);
      changed = true;
    }
    if (changed) scheduleFlush();
  },
  /** An explicit scan of these tasks retries their failures. */
  clearForTasks(tasks: readonly string[]): void {
    if (tasks.length === 0) return;
    const wanted = new Set(tasks);
    const map = load();
    let changed = false;
    for (const key of map.keys()) {
      if (!wanted.has(taskOf(key))) continue;
      map.delete(key);
      changed = true;
    }
    if (changed) scheduleFlush();
  },
  clearAll(): void {
    if (load().size === 0) return;
    records = new Map();
    scheduleFlush();
  },
  flush,
};

/** Flush on the way out so a relaunch never loses the most recent failures. */
export function attachFailurePersistence(): void {
  if (attached) return;
  attached = true;
  window.addEventListener("pagehide", flush);
}
