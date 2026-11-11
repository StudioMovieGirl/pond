import { useSelector } from "@tanstack/react-store";
import { Store } from "@tanstack/store";
import type { TaskProgress } from "./progress-tracker";

export interface EnrichmentFailure {
  key: string;
  saveId: string;
  title: string | null;
  task: string;
  reason: string;
}

export interface MissingOriginal {
  id: string;
  title: string | null;
}

interface EnrichmentStatus {
  inflight: number;
  activeKeys: ReadonlySet<string>;
  /** Task whose run is executing right now (the sweep is one-at-a-time). */
  activeTask: string | null;
  failedKeys: ReadonlySet<string>;
  failures: readonly EnrichmentFailure[];
  missingOriginals: readonly MissingOriginal[];
  /** Per-task backlog, timing, and estimate; stable across scans and launches. */
  progress: readonly TaskProgress[];
}

const store = new Store<EnrichmentStatus>({
  inflight: 0,
  activeKeys: new Set<string>(),
  activeTask: null,
  failedKeys: new Set<string>(),
  failures: [],
  missingOriginals: [],
  progress: [],
});

export const enrichmentMonitor = {
  snapshot: () => store.state,
  subscribe: (listener: () => void) => store.subscribe(listener),
  set(patch: Partial<EnrichmentStatus>): void {
    store.setState((s) => ({ ...s, ...patch }));
  },
};

export function useEnrichmentStatus() {
  return useSelector(store, (state) => state);
}
