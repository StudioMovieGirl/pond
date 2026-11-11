import type { Prefs } from "@pond/schema/db";
import { Button, Checkbox, Settings } from "@pond/ui";
import prettyMs from "pretty-ms";
import { useEffect, useMemo, useState } from "react";
import {
  type TaskProgress,
  taskBackend,
  useEnrichmentStatus,
} from "@/features/enrichment/status";
import {
  formatDuration,
  formatNumber,
  formatPlural,
} from "@/shared/lib/format";
import { usePrefs } from "@/shared/state/prefs";
import { SCAN_TASKS, type TaskMeta } from "../tasks-meta";
import styles from "./styles.module.css";

const FAILURES = { one: "failure", other: "failures" };

/** Compact estimate, e.g. "34m" or "1.2h". */
function estimate(ms: number): string {
  return prettyMs(Math.max(0, Math.round(ms)), { compact: true });
}

interface RowCopy {
  /** Live line for a running task, e.g. "Using provider model (Ollama)". */
  running?: string;
  /** Count line, e.g. "1,240 left · 12:30 elapsed · ~1h 2m est". */
  detail: string;
  /** Set while this task is the one actually running. */
  active: boolean;
}

function rowCopy(
  progress: TaskProgress | undefined,
  backend: { running: string },
  now: number,
  active: boolean,
): RowCopy {
  if (!progress) {
    return { detail: "Waiting for a scan", active: false };
  }
  const remaining = progress.pending;
  if (active && remaining > 0) {
    const parts: string[] = [`${formatNumber(remaining)} left`];
    if (progress.startedAt != null)
      parts.push(
        `${formatDuration((now - progress.startedAt) / 1000)} elapsed`,
      );
    if (progress.avgMs != null)
      parts.push(
        `~${estimate(progress.avgMs * (progress.done + remaining))} est`,
      );
    return {
      running: backend.running,
      detail: parts.join(" · "),
      active: true,
    };
  }
  const parts: string[] = [];
  if (progress.pending > 0)
    parts.push(`${formatNumber(progress.pending)} left`);
  if (progress.failed > 0)
    parts.push(`${formatPlural(progress.failed, FAILURES)} failed`);
  if (parts.length > 0) return { detail: parts.join(" · "), active: false };
  if (progress.done > 0 && progress.totalRunMs > 0) {
    return {
      detail: `Up to date · ${estimate(progress.totalRunMs)} taken`,
      active: false,
    };
  }
  return { detail: "Up to date", active: false };
}

export function ScanLibrary() {
  const status = useEnrichmentStatus();
  const [ai, , loaded] = usePrefs("ai");
  return (
    <ScanLibraryCard
      status={status}
      ai={ai}
      loaded={loaded}
      onRun={(tasks) => {
        void import("@/features/enrichment").then(({ scanLibraryTasks }) => {
          scanLibraryTasks(tasks);
        });
      }}
    />
  );
}

export function ScanLibraryCard({
  status,
  ai,
  loaded = true,
  onRun,
}: {
  status: {
    inflight: number;
    activeTask?: string | null;
    progress?: readonly TaskProgress[];
  };
  ai: Prefs["ai"] | null;
  loaded?: boolean;
  onRun: (tasks: readonly string[]) => void;
}) {
  const tasks = useMemo(
    () => SCAN_TASKS.filter((task) => task.enabled(ai)),
    [ai],
  );
  /** Tasks the user unchecked; everything else stays selected by default. */
  const [unchecked, setUnchecked] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    setUnchecked((previous) => {
      const known = new Set(tasks.map((task) => task.id));
      const next = new Set([...previous].filter((id) => known.has(id)));
      return next.size === previous.size ? previous : next;
    });
  }, [tasks]);
  const selected = tasks
    .filter((task) => !unchecked.has(task.id))
    .map((task) => task.id);
  const anyRunning =
    (status.progress?.some((row) => row.inflight > 0) ?? false) ||
    status.inflight > 0;

  /** Elapsed and estimates are wall-clock, so tick while anything is running. */
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!anyRunning) return;
    const timer = setInterval(() => setTick((tick) => tick + 1), 1000);
    return () => clearInterval(timer);
  }, [anyRunning]);

  const activeTask = status.activeTask ?? null;
  const progressByTask = new Map(
    (status.progress ?? []).map((row) => [row.task, row]),
  );

  function toggle(taskId: string, checked: boolean): void {
    setUnchecked((previous) => {
      const next = new Set(previous);
      if (checked) next.delete(taskId);
      else next.add(taskId);
      return next;
    });
  }

  return (
    <Settings.List className={styles.card}>
      <div className={styles.head}>
        <Settings.ItemDetails>
          <Settings.ItemDescription className={styles.description}>
            Choose which tasks to run across every Save.
          </Settings.ItemDescription>
        </Settings.ItemDetails>
        <Button
          className={styles.run}
          size="sm"
          variant="secondary"
          disabled={!loaded || anyRunning || selected.length === 0}
          onClick={() => onRun(selected)}
        >
          {anyRunning
            ? "Scanning Library"
            : selected.length === 0
              ? "Nothing Selected"
              : `Scan ${formatPlural(selected.length, { one: "task", other: "tasks" })}`}
        </Button>
      </div>
      {tasks.length === 0 ? (
        <p className={styles.empty}>
          Turn on a processing option below to scan your library.
        </p>
      ) : (
        <div className={styles.rows}>
          {tasks.map((task) => (
            <TaskRow
              key={task.id}
              task={task}
              ai={ai}
              checked={!unchecked.has(task.id)}
              disabled={anyRunning}
              progress={progressByTask.get(task.id)}
              active={
                (progressByTask.get(task.id)?.inflight ?? 0) > 0 &&
                activeTask === task.id
              }
              onChecked={(checked) => toggle(task.id, checked)}
            />
          ))}
        </div>
      )}
    </Settings.List>
  );
}

function TaskRow({
  task,
  ai,
  checked,
  disabled,
  progress,
  active,
  onChecked,
}: {
  task: TaskMeta;
  ai: Prefs["ai"] | null;
  checked: boolean;
  disabled: boolean;
  progress: TaskProgress | undefined;
  active: boolean;
  onChecked: (checked: boolean) => void;
}) {
  const id = `scan-task-${task.id}`;
  const backend = taskBackend(task.id, ai);
  const now = Date.now();
  const copy = rowCopy(progress, backend, now, active);
  return (
    <label className={styles.row} htmlFor={id}>
      <Checkbox.Root
        id={id}
        size="sm"
        checked={checked}
        disabled={disabled}
        onCheckedChange={(value) => onChecked(value === true)}
      >
        <Checkbox.Indicator />
      </Checkbox.Root>
      <span className={styles.names}>
        <span className={styles.label}>{task.label}</span>
        <span className={styles.chip}>{backend.chip}</span>
      </span>
      <span
        className={styles.status}
        data-active={copy.active || undefined}
        aria-live="polite"
      >
        {copy.running ? (
          <>
            <span className={styles.running}>{copy.running}</span>
            <span>{copy.detail}</span>
          </>
        ) : (
          copy.detail
        )}
      </span>
    </label>
  );
}
