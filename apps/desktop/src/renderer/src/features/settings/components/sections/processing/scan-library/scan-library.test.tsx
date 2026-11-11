import { DEFAULT_PREFS, type Prefs } from "@pond/schema";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { ScanLibraryCard } from "./index";

function allOn(overrides: Partial<Prefs["ai"]> = {}): Prefs["ai"] {
  return {
    ...DEFAULT_PREFS.ai,
    semanticSearch: true,
    enableCaption: true,
    enableOcr: true,
    enableTranscript: true,
    enableClip: true,
    enableAesthetic: true,
    enableSensitiveContent: true,
    enableAutoTitle: true,
    enableSuggestedTags: true,
    ...overrides,
  };
}

it("lists every enabled task with its backend and scans the selection", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  let scanned: readonly string[] = [];
  try {
    await act(async () => {
      root.render(
        <ScanLibraryCard
          status={{ inflight: 0 }}
          ai={allOn({ mediaUnderstandingMode: "gemma4" })}
          onRun={(tasks) => {
            scanned = tasks;
          }}
        />,
      );
    });
    expect(host.textContent).toContain("Image Captions");
    expect(host.textContent).toContain("Suggested Tags");
    expect(host.textContent).toContain("Provider model (Ollama)");
    expect(host.textContent).toContain("On this device");
    const scan = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (element) => element.textContent?.startsWith("Scan"),
    );
    expect(scan?.textContent).toBe("Scan 9 tasks");
    await act(async () => scan?.click());
    expect(scanned).toHaveLength(9);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

it("shows where the running task's model lives plus elapsed and estimate", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => {
      root.render(
        <ScanLibraryCard
          status={{
            inflight: 3,
            activeTask: "caption",
            progress: [
              {
                task: "caption",
                pending: 2,
                inflight: 2,
                failed: 0,
                done: 5,
                startedAt: Date.now() - 60_000,
                totalRunMs: 10_000,
                avgMs: 2_000,
              },
              {
                task: "ocr",
                pending: 1,
                inflight: 1,
                failed: 0,
                done: 0,
                startedAt: null,
                totalRunMs: 0,
                avgMs: null,
              },
            ],
          }}
          ai={allOn({
            mediaUnderstandingMode: "gemma4",
            mediaUnderstandingProvider: "lmstudio",
          })}
          onRun={() => {}}
        />,
      );
    });
    expect(host.textContent).toContain("Using provider model (LM Studio)");
    expect(host.textContent).toContain("2 left");
    expect(host.textContent).toContain("1:00 elapsed");
    expect(host.textContent).toContain("~14s est");
    // The queued task does not claim the running label.
    expect(host.textContent).not.toContain("Running on this device");
    const scan = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (element) => element.textContent !== null,
    );
    expect(scan?.textContent).toBe("Scanning Library");
    expect(scan?.disabled).toBe(true);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

it("keeps unchecked tasks out of the scan", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  let scanned: readonly string[] = [];
  try {
    await act(async () => {
      root.render(
        <ScanLibraryCard
          status={{ inflight: 0 }}
          ai={allOn()}
          onRun={(tasks) => {
            scanned = tasks;
          }}
        />,
      );
    });
    const boxes = [...host.querySelectorAll<HTMLInputElement>("input")];
    const ocr = boxes.find((box) => box.id === "scan-task-ocr");
    expect(ocr).toBeDefined();
    await act(async () => {
      ocr?.click();
    });
    const scan = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (element) => element.textContent?.startsWith("Scan"),
    );
    expect(scan?.textContent).toBe("Scan 8 tasks");
    await act(async () => scan?.click());
    expect(scanned).not.toContain("ocr");
    expect(scanned).toHaveLength(8);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

it("explains that nothing is offered when no processing is enabled", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => {
      root.render(
        <ScanLibraryCard
          status={{ inflight: 0 }}
          ai={DEFAULT_PREFS.ai}
          onRun={() => {}}
        />,
      );
    });
    expect(host.textContent).toContain(
      "Turn on a processing option below to scan your library.",
    );
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
