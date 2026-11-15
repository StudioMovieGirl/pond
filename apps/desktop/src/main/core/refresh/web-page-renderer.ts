import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import { NAV_TIMEOUT_MS } from "./harvest-window/constants";
import { navigateWithTimeout } from "./harvest-window/navigation";
import { leaseWindow } from "./harvest-window/pool";

export { browserUserAgent } from "./harvest-window/constants";

const RENDER_SETTLE_MS = 1_500;
const RENDER_READ_TIMEOUT_MS = 10_000;
const RenderedHtmlSchema = z.string().trim().min(1);

export type RenderPageResult =
  | { ok: true; html: string; status: number }
  | { ok: false; reason: "navigation" | "read-timeout" | "empty" };

export async function renderPageHtml(
  url: string,
  signal?: AbortSignal,
): Promise<RenderPageResult> {
  const lease = await leaseWindow("web", { signal });
  try {
    const webContents = lease.win.webContents;
    let status = 0;
    const onNavigate = (_event: Electron.Event, _url: string, code: number) => {
      status = code;
    };
    webContents.on("did-navigate", onNavigate);
    let loaded: boolean;
    try {
      loaded = await navigateWithTimeout(lease.win, url, NAV_TIMEOUT_MS);
    } finally {
      webContents.off("did-navigate", onNavigate);
    }
    if (!loaded) return { ok: false, reason: "navigation" };
    await sleep(RENDER_SETTLE_MS);
    const html: unknown = await Promise.race([
      webContents.executeJavaScript("document.documentElement.outerHTML", true),
      sleep(RENDER_READ_TIMEOUT_MS).then(() => null),
    ]);
    if (html === null) return { ok: false, reason: "read-timeout" };
    const rendered = RenderedHtmlSchema.safeParse(html);
    return rendered.success
      ? { ok: true, html: rendered.data, status }
      : { ok: false, reason: "empty" };
  } finally {
    lease.release();
  }
}

const CAPTURE_SETTLE_MS = 2_500;
const CAPTURE_TIMEOUT_MS = 15_000;

export type PageScreenshot =
  | { ok: true; png: Uint8Array; width: number; height: number }
  | { ok: false; reason: "navigation" | "destroyed" | "capture" };

/**
 * Renders a page in the shared hidden "web" window and captures its viewport
 * as a PNG. Used as the cover image for web-page saves so the card shows the
 * page itself instead of the site's og:image. Fails soft (never throws) so a
 * flaky capture can't strand an otherwise good save.
 */
export async function screenshotPage(
  url: string,
  signal?: AbortSignal,
): Promise<PageScreenshot> {
  const lease = await leaseWindow("web", { signal });
  try {
    const webContents = lease.win.webContents;
    const loaded = await navigateWithTimeout(lease.win, url, NAV_TIMEOUT_MS);
    if (!loaded) return { ok: false, reason: "navigation" };
    await sleep(CAPTURE_SETTLE_MS);
    if (lease.win.isDestroyed() || webContents.isDestroyed()) {
      return { ok: false, reason: "destroyed" };
    }
    const image = await Promise.race([
      webContents.capturePage(),
      sleep(CAPTURE_TIMEOUT_MS).then(() => null),
    ]);
    if (image === null || image.isEmpty()) {
      return { ok: false, reason: "capture" };
    }
    const { width, height } = image.getSize();
    return { ok: true, png: image.toPNG(), width, height };
  } catch {
    return { ok: false, reason: "capture" };
  } finally {
    lease.release();
  }
}
