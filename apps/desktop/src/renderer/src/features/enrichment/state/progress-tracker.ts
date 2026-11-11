/**
 * Per-task sweep progress. Pending and failed counts are keyed by Save so a
 * full scan recomputes them exactly and a scoped scan (one or a few Saves)
 * adjusts them incrementally. Timing is monotonic within the session: `done`,
 * `totalRunMs`, and the per-item average never reset, so the estimate keeps
 * improving as the backlog drains.
 */

export interface TaskProgress {
  task: string;
  /**
   * Eligible Saves not yet done or failed, including in-flight work. The set
   * only shrinks as runs finish, so it is the stable "remaining" count.
   */
  pending: number;
  /** Queued or running right now. */
  inflight: number;
  /** Known failures for this task (persisted across launches). */
  failed: number;
  /** Runs that finished successfully in this session. */
  done: number;
  /** Session wall clock when this task's first run started. */
  startedAt: number | null;
  /** Cumulative model time for this task in this session. */
  totalRunMs: number;
  /** Exponential moving average of per-item run time. */
  avgMs: number | null;
}

export interface ReconcileEntry {
  task: string;
  saveId: string;
  pending: boolean;
  failed: boolean;
}

interface TaskTiming {
  done: number;
  startedAt: number | null;
  totalRunMs: number;
  avgMs: number | null;
}

const EMPTY_TIMING: TaskTiming = {
  done: 0,
  startedAt: null,
  totalRunMs: 0,
  avgMs: null,
};

/** Weights the newest run so a slow cold model warms up quickly without one outlier dominating. */
const EMA_FACTOR = 0.2;

export function createProgressTracker() {
  const pendingByTask = new Map<string, Set<string>>();
  const failedByTask = new Map<string, Set<string>>();
  const timing = new Map<string, TaskTiming>();

  function setOf(map: Map<string, Set<string>>, task: string): Set<string> {
    let set = map.get(task);
    if (!set) {
      set = new Set();
      map.set(task, set);
    }
    return set;
  }

  function apply(
    task: string,
    saveId: string,
    pending: boolean,
    failed: boolean,
  ): void {
    const pendingSet = setOf(pendingByTask, task);
    const failedSet = setOf(failedByTask, task);
    if (pending) pendingSet.add(saveId);
    else pendingSet.delete(saveId);
    if (failed) failedSet.add(saveId);
    else failedSet.delete(saveId);
  }

  return {
    /**
     * `coveredTasks` names every task this scan looked at. When `fullSaves`
     * is set the scan saw the whole library, so those tasks start clean
     * before the entries are applied; otherwise only the named Saves move.
     */
    reconcile(
      entries: readonly ReconcileEntry[],
      coveredTasks: readonly string[],
      fullSaves: boolean,
    ): void {
      if (fullSaves) {
        for (const task of coveredTasks) {
          pendingByTask.delete(task);
          failedByTask.delete(task);
        }
      }
      for (const entry of entries)
        apply(entry.task, entry.saveId, entry.pending, entry.failed);
    },
    /** A run finished successfully: the Save leaves the pending set. */
    complete(task: string, saveId: string, ms: number, now: number): void {
      recordTiming(timing, task, ms, now);
      pendingByTask.get(task)?.delete(saveId);
    },
    /** A run failed: the Save moves from pending to failed. */
    markFailed(task: string, saveId: string): void {
      pendingByTask.get(task)?.delete(saveId);
      setOf(failedByTask, task).add(saveId);
    },
    /** The first run for this task is starting, so its clock begins now. */
    markStarted(task: string, now: number): void {
      let entry = timing.get(task);
      if (!entry) {
        entry = { ...EMPTY_TIMING };
        timing.set(task, entry);
      }
      if (entry.startedAt == null) entry.startedAt = now;
    },
    /** The Save's files are gone, so no task can run or fail for it. */
    removeSave(saveId: string): void {
      for (const set of pendingByTask.values()) set.delete(saveId);
      for (const set of failedByTask.values()) set.delete(saveId);
    },
    snapshot(inflightKeys: Iterable<string>): TaskProgress[] {
      const inflight = new Map<string, number>();
      for (const key of inflightKeys) {
        const index = key.indexOf(":");
        const task = index === -1 ? key : key.slice(0, index);
        inflight.set(task, (inflight.get(task) ?? 0) + 1);
      }
      const tasks = new Set<string>([
        ...pendingByTask.keys(),
        ...failedByTask.keys(),
        ...timing.keys(),
        ...inflight.keys(),
      ]);
      const rows: TaskProgress[] = [];
      for (const task of tasks) {
        const entry = timing.get(task) ?? EMPTY_TIMING;
        rows.push({
          task,
          pending: pendingByTask.get(task)?.size ?? 0,
          inflight: inflight.get(task) ?? 0,
          failed: failedByTask.get(task)?.size ?? 0,
          done: entry.done,
          startedAt: entry.startedAt,
          totalRunMs: entry.totalRunMs,
          avgMs: entry.avgMs,
        });
      }
      return rows;
    },
  };
}

function recordTiming(
  timing: Map<string, TaskTiming>,
  task: string,
  ms: number,
  now: number,
): void {
  let entry = timing.get(task);
  if (!entry) {
    entry = { ...EMPTY_TIMING };
    timing.set(task, entry);
  }
  entry.done += 1;
  entry.totalRunMs += ms;
  entry.avgMs =
    entry.avgMs == null ? ms : entry.avgMs * (1 - EMA_FACTOR) + ms * EMA_FACTOR;
  if (entry.startedAt == null) entry.startedAt = now;
}
