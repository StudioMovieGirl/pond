import type { Prefs } from "@pond/schema/db";

/**
 * The tasks the Scan Library card offers, in the same order the sweep runs
 * them. Enabled mirrors the sweep's per-task preference check so a row is
 * only offered when its switch is on.
 */

export interface TaskMeta {
  id: string;
  label: string;
  enabled: (ai: Prefs["ai"] | null) => boolean;
}

export const SCAN_TASKS: readonly TaskMeta[] = [
  {
    id: "caption",
    label: "Image Captions",
    enabled: (ai) => ai?.enableCaption === true,
  },
  {
    id: "ocr",
    label: "Text in Images",
    enabled: (ai) => ai?.enableOcr === true,
  },
  {
    id: "transcript",
    label: "Transcription",
    enabled: (ai) => ai?.enableTranscript === true,
  },
  {
    id: "clip",
    label: "Visual Similarity",
    enabled: (ai) => ai?.enableClip === true,
  },
  {
    id: "aesthetic",
    label: "Style Labels",
    enabled: (ai) => ai?.enableAesthetic === true,
  },
  {
    id: "sensitive-content",
    label: "Sensitive Content",
    enabled: (ai) => ai?.enableSensitiveContent === true,
  },
  {
    id: "textEmbedding",
    label: "Semantic Search",
    enabled: (ai) => ai?.semanticSearch === true,
  },
  {
    id: "autoTitle",
    label: "Generated Titles",
    enabled: (ai) => ai?.enableAutoTitle === true,
  },
  {
    id: "suggestedTags",
    label: "Suggested Tags",
    enabled: (ai) =>
      ai?.enableSuggestedTags === true && ai?.semanticSearch === true,
  },
];
