import { env } from "@huggingface/transformers";
import { z } from "zod";

type InferenceDevice = "webgpu" | "wasm";

const CoreCountSchema = z.number().catch(4);

let wasmConfigured = false;
let wasmThreads = 1;
/** transformers.js/onnxruntime-web default to all logical cores, which pegs the machine on the CPU path; half the cores keeps the UI responsive while still making progress. */
function capWasmThreads(): void {
  if (wasmConfigured) return;
  wasmConfigured = true;
  const cores = CoreCountSchema.parse(
    globalThis.navigator?.hardwareConcurrency,
  );
  const isolated = globalThis.crossOriginIsolated === true;
  const hasSAB = "SharedArrayBuffer" in globalThis;
  /** Multi-threaded WASM needs cross-origin isolation AND SharedArrayBuffer; otherwise onnxruntime silently runs single-threaded. */
  wasmThreads = isolated && hasSAB ? Math.max(1, Math.floor(cores / 2)) : 1;
  try {
    const onnx = env.backends.onnx as {
      versions?: { web?: string };
      wasm?: {
        numThreads?: number;
        wasmPaths?: string | { mjs: string; wasm: string };
      };
    };
    const wasm = onnx.wasm;
    if (wasm) wasm.numThreads = wasmThreads;
    /** transformers.js defaults to the asyncify WASM build, which lacks the GatherBlockQuantized kernel the q4 EmbeddingGemma vision encoder needs; the standard build implements it. */
    const webVersion = onnx.versions?.web;
    if (wasm && webVersion) {
      const prefix = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${webVersion}/dist/`;
      wasm.wasmPaths = {
        mjs: `${prefix}ort-wasm-simd-threaded.mjs`,
        wasm: `${prefix}ort-wasm-simd-threaded.wasm`,
      };
    }
  } catch {}
  console.info(
    `[inference] wasm threads=${wasmThreads} (cores=${cores}, crossOriginIsolated=${isolated}, SharedArrayBuffer=${hasSAB})`,
  );
  if (!isolated) {
    console.warn(
      "[inference] page is NOT cross-origin isolated — WASM inference is " +
        "single-threaded. Check COOP/COEP headers on the renderer.",
    );
  }
}

export function configuredWasmThreads(): number {
  capWasmThreads();
  return wasmThreads;
}

let devicePromise: Promise<InferenceDevice> | null = null;

/**
 * Probed once and cached for the session: `'gpu' in navigator` can be true while requestAdapter() resolves null, so only a real adapter counts as WebGPU.
 * @remarks Never requests a fallback adapter; a software adapter runs on the CPU and is hotter than plain WASM.
 */
export function pickDevice(): Promise<InferenceDevice> {
  if (!devicePromise) {
    devicePromise = (async (): Promise<InferenceDevice> => {
      capWasmThreads();
      try {
        const gpu = navigator.gpu;
        if (gpu) {
          const adapter = await gpu.requestAdapter();
          if (adapter) {
            console.info("[inference] using WebGPU");
            return "webgpu";
          }
        }
      } catch (err) {
        console.warn("[inference] WebGPU probe failed", err);
      }
      console.warn(
        "[inference] no WebGPU adapter — running on CPU (WASM); on-device " +
          "inference will be slower and run the machine warmer",
      );
      return "wasm";
    })();
  }
  return devicePromise;
}
