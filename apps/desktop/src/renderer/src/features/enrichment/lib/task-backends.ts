import type { Prefs } from "@pond/schema/db";

/**
 * Where each task's model actually runs, so the Scan Library UI can say
 * "Running on this device" or "Using provider model (Ollama)" per task.
 */

export interface TaskBackend {
  /** Static chip text, e.g. "On this device" or "Provider model (Ollama)". */
  chip: string;
  /** Live status text while the task is running. */
  running: string;
}

const ON_DEVICE: TaskBackend = {
  chip: "On this device",
  running: "Running on this device",
};

function providerName(
  provider: Prefs["ai"]["mediaUnderstandingProvider"],
): string {
  return provider === "lmstudio" ? "LM Studio" : "Ollama";
}

export function taskBackend(task: string, ai: Prefs["ai"] | null): TaskBackend {
  if (task === "caption" || task === "ocr") {
    if (ai?.mediaUnderstandingMode === "gemma4") {
      const provider = providerName(ai.mediaUnderstandingProvider);
      return {
        chip: `Provider model (${provider})`,
        running: `Using provider model (${provider})`,
      };
    }
    return ON_DEVICE;
  }
  if (task === "autoTitle") {
    return { chip: "No model needed", running: "Running on this device" };
  }
  return ON_DEVICE;
}
