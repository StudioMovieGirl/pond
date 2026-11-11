/**
 * Human copy for local media-understanding failure reasons. The main process
 * reports snake_case reasons inside an error message
 * ("Local media understanding failed: model_unavailable"), and the sweep
 * stores whatever message it saw, so map both back to one sentence.
 */

const REASON_COPY = {
  invalid_input: "The image request is invalid.",
  aborted: "Image understanding was canceled.",
  timeout: "Image understanding took too long.",
  model_unavailable: "The selected local model is unavailable.",
  generation_failed: "The local model could not understand the image.",
  empty_output: "The local model returned an empty caption.",
  model_chatter: "The local model returned commentary instead of the result.",
  output_too_long: "The local model returned more text than allowed.",
  read_failed: "Pond couldn't read the image file.",
  unsupported_media: "That file type can't be sent to the local model.",
  too_large: "That image is too large for the local model.",
  missing: "The image file is missing.",
  internal_error: "Something went wrong while understanding the image.",
} satisfies Record<string, string>;

export function failureCopy(reason: string): string {
  const bare = reason
    .replace(/^Local media understanding failed:\s*/i, "")
    .trim();
  return REASON_COPY[bare as keyof typeof REASON_COPY] ?? reason;
}
