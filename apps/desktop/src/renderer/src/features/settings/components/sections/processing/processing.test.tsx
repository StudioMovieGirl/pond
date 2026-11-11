import { DEFAULT_PREFS } from "@pond/schema";
import { MotionConfig } from "motion/react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { ProcessingStatusCard } from "./";

function button(host: HTMLElement, name: string) {
  return [...host.querySelectorAll<HTMLButtonElement>("button")].find(
    (element) =>
      element.textContent === name ||
      element.getAttribute("aria-label") === name,
  );
}

it("groups running tasks into one count with the breakdown on hover", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => {
      root.render(
        <MotionConfig reducedMotion="always">
          <ProcessingStatusCard
            enabled
            ai={null}
            status={{
              inflight: 2,
              activeKeys: new Set(["caption:save-1", "ocr:save-1"]),
              failedKeys: new Set(["sensitive-content:save-2"]),
            }}
            onCheck={async () => {}}
            onRepair={() => {}}
          />
        </MotionConfig>,
      );
    });
    expect(host.textContent).toContain("Processing your library");
    expect(host.textContent).toContain("2 tasks left");
    expect(host.textContent).not.toContain("couldn't finish");
    expect(button(host, "Task Details")).toBeDefined();
    expect(button(host, "Retry")).toBeUndefined();
    expect(button(host, "Check Library")?.disabled).toBe(true);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

it("offers a retry once processing stops with failures", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  let calls = 0;
  try {
    await act(async () => {
      root.render(
        <ProcessingStatusCard
          enabled
          ai={null}
          status={{
            inflight: 0,
            activeKeys: new Set(),
            failedKeys: new Set(["ocr:save-1", "caption:save-2"]),
          }}
          onCheck={async () => {
            calls += 1;
          }}
          onRepair={() => {}}
        />,
      );
    });
    expect(host.textContent).toContain("Processing needs attention");
    expect(host.textContent).toContain("2 tasks couldn't finish");
    expect(host.textContent).toContain("save-1: Text in Images");
    expect(host.textContent).toContain("save-2: Image Captions");
    expect(button(host, "Check Library")).toBeUndefined();
    expect(button(host, "Task Details")).toBeDefined();
    await act(async () => button(host, "Retry")?.click());
    expect(calls).toBe(1);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

it("names a save whose files are missing and opens repair", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  let repaired = 0;
  try {
    await act(async () => {
      root.render(
        <MotionConfig reducedMotion="always">
          <ProcessingStatusCard
            enabled
            ai={null}
            status={{
              inflight: 0,
              activeKeys: new Set(),
              failedKeys: new Set([
                "caption:01M6G9W0KWQJNCXVE71HCTPDDS",
                "clip:01M6G9W0KWQJNCXVE71HCTPDDS",
              ]),
              missingOriginals: [
                {
                  id: "01M6G9W0KWQJNCXVE71HCTPDDS",
                  title: "Screenshot From 2026-10-30 08-21-58.png",
                },
              ],
            }}
            onCheck={async () => {}}
            onRepair={() => {
              repaired += 1;
            }}
          />
        </MotionConfig>,
      );
    });
    expect(host.textContent).toContain(
      "Files missing for Screenshot From 2026-10-30 08-21-58.png.",
    );
    expect(host.textContent).not.toContain("couldn't finish");
    await act(async () => button(host, "Repair Invalid Content")?.click());
    expect(repaired).toBe(1);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

it("prevents duplicate checks and recovers when starting a check fails", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  let calls = 0;
  let failCheck: (reason: Error) => void = () => {};
  const pending = new Promise<void>((_resolve, reject) => {
    failCheck = reject;
  });
  try {
    await act(async () => {
      root.render(
        <ProcessingStatusCard
          enabled
          ai={null}
          status={{ inflight: 0, activeKeys: new Set(), failedKeys: new Set() }}
          onCheck={() => {
            calls += 1;
            return calls === 1 ? pending : Promise.resolve();
          }}
          onRepair={() => {}}
        />,
      );
    });
    const check = button(host, "Check Library");
    await act(async () => check?.click());
    expect(host.textContent).toContain("Checking your library");
    expect(check?.disabled).toBe(true);
    await act(async () => check?.click());
    expect(calls).toBe(1);
    await act(async () => failCheck(new Error("Unavailable")));
    expect(host.textContent).toContain("Couldn't check your library");
    await act(async () => button(host, "Retry")?.click());
    expect(calls).toBe(2);
    expect(host.textContent).toContain("Ready for new items");
    expect(host.textContent).not.toContain("up to date");
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

it("keeps the check unavailable until preferences load and processing is enabled", async () => {
  const host = document.createElement("div");
  const root = createRoot(host);
  try {
    for (const loaded of [false, true]) {
      await act(async () => {
        root.render(
          <ProcessingStatusCard
            enabled={false}
            ai={null}
            loaded={loaded}
            status={{
              inflight: 0,
              activeKeys: new Set(),
              failedKeys: new Set(),
            }}
            onCheck={async () => {}}
            onRepair={() => {}}
          />,
        );
      });
      expect(button(host, "Check Library")?.disabled).toBe(true);
      expect(host.textContent).toContain(
        loaded ? "Local processing is off" : "Loading processing settings",
      );
    }
  } finally {
    await act(async () => root.unmount());
  }
});

it("counts stable items left with an estimate while the sweep runs", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => {
      root.render(
        <ProcessingStatusCard
          enabled
          ai={{
            ...DEFAULT_PREFS.ai,
            mediaUnderstandingMode: "gemma4",
            mediaUnderstandingProvider: "lmstudio",
          }}
          status={{
            inflight: 3,
            activeKeys: new Set([
              "caption:save-1",
              "caption:save-2",
              "ocr:save-3",
            ]),
            activeTask: "caption",
            failedKeys: new Set(["ocr:save-4"]),
            failures: [
              {
                key: "ocr:save-4",
                saveId: "save-4",
                title: "Broken",
                task: "ocr",
                reason: "Local media understanding failed: model_unavailable",
              },
            ],
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
                failed: 1,
                done: 3,
                startedAt: Date.now() - 30_000,
                totalRunMs: 5_000,
                avgMs: 2_000,
              },
            ],
          }}
          onCheck={async () => {}}
          onRepair={() => {}}
        />,
      );
    });
    // Stable item count (pending, not the raw in-flight key set) plus estimate.
    expect(host.textContent).toContain("3 items left");
    expect(host.textContent).toContain("~6s to go");
    // The running task names its backend in the breakdown.
    expect(button(host, "Task Details")).toBeDefined();
    expect(button(host, "Check Library")?.disabled).toBe(true);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

it("names failed runs in plain language from the sweep", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => {
      root.render(
        <ProcessingStatusCard
          enabled
          ai={null}
          status={{
            inflight: 0,
            activeKeys: new Set(),
            failedKeys: new Set(["ocr:save-1"]),
            failures: [
              {
                key: "ocr:save-1",
                saveId: "save-1",
                title: "Shot",
                task: "ocr",
                reason: "Local media understanding failed: model_unavailable",
              },
            ],
          }}
          onCheck={async () => {}}
          onRepair={() => {}}
        />,
      );
    });
    expect(host.textContent).toContain(
      "The selected local model is unavailable.",
    );
    expect(button(host, "Retry")).toBeDefined();
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
