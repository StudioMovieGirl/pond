/**
 * Enrichment status for the Settings window, which does not load enrichment
 * tasks or models. The pure helpers here (failure copy, backend labels) are
 * the only cross-feature imports allowed through this entry.
 */

export { failureCopy } from "./lib/failure-copy";
export { type TaskBackend, taskBackend } from "./lib/task-backends";
export {
  type EnrichmentFailure,
  type MissingOriginal,
  useEnrichmentStatus,
} from "./state/enrichment-monitor";
export type { TaskProgress } from "./state/progress-tracker";
