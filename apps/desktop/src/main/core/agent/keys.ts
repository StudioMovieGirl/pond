import type { JsonValue } from "@pond/schema/json";
import { z } from "zod";
import {
  ASSISTANT_MODELS,
  type AssistantProvider,
  assistantCatalog,
} from "../../../shared/assistant";
import { KEYCHAIN_AGENT_PREFIX } from "../../../shared/constants";
import {
  modelsForChooser,
  type ProviderModelsResult,
} from "../../../shared/provider-models";
import type {
  OkResult,
  OkSuccess,
} from "../../../shared/query-contracts-shared";
import { deleteSecret, getSecret, getSecrets, setSecret } from "../../keychain";
import { getPrefs, setPrefs } from "../prefs";
import { appleStatus } from "./apple-runtime";
import {
  checkCliConnection,
  isCliProvider,
  listCliModels,
} from "./cli-runtime";
import { isLocalProviderConnected } from "./local-provider-state";
import { catalogModelsForProvider, loadModelCatalog } from "./model-catalog";
import { OPENCODE_GO_MODELS_BASE_URL } from "./opencode-go";
import { OPENROUTER_KEY_URL, OPENROUTER_MODELS_URL } from "./openrouter";
import {
  declaredLocalModelCapabilities,
  modelsFromProviderResponse,
  SKIP,
} from "./provider-models";

const AGENT_PROVIDERS = ASSISTANT_MODELS.map((model) => model.id);
export type AgentProviderId = AssistantProvider;

const OPENAI_MODELS = {
  openai: "https://api.openai.com/v1",
  xai: "https://api.x.ai/v1",
  groq: "https://api.groq.com/openai/v1",
  mistral: "https://api.mistral.ai/v1",
  togetherai: "https://api.together.xyz/v1",
  fireworks: "https://api.fireworks.ai/inference/v1",
  deepinfra: "https://api.deepinfra.com/v1/openai",
  cerebras: "https://api.cerebras.ai/v1",
  perplexity: "https://api.perplexity.ai",
  baseten: "https://inference.baseten.co/v1",
  cohere: "https://api.cohere.com/v2",
  "opencode-go": OPENCODE_GO_MODELS_BASE_URL,
} as const;

function isOpenAIModelsProvider(
  provider: AgentProviderId,
): provider is keyof typeof OPENAI_MODELS {
  return provider in OPENAI_MODELS;
}

export function parseProvider(value: string): AgentProviderId | null {
  return AGENT_PROVIDERS.find((provider) => provider === value) ?? null;
}

function accountFor(provider: AgentProviderId): string {
  return `${KEYCHAIN_AGENT_PREFIX}:${provider}`;
}

function mask(key: string): string {
  if (key.length < 8) return "••••";
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

function listedProviders(added: string[], provider: AgentProviderId) {
  return [...new Set([...added, provider])];
}

function withoutProvider(added: string[], provider: AgentProviderId) {
  return added.filter((id) => id !== provider);
}

export async function listKeys(): Promise<
  Array<{
    provider: AgentProviderId;
    hasKey: boolean;
    masked: string | null;
    enabled: boolean;
  }>
> {
  const prefs = await getPrefs();
  const enabledKeys = prefs.agent.enabledKeys ?? {};
  const secrets = await getSecrets(AGENT_PROVIDERS.map(accountFor));
  const rows = [];
  for (const provider of AGENT_PROVIDERS) {
    const key = secrets[accountFor(provider)];
    const local = isLocalProviderConnected(provider, prefs.agent);
    rows.push({
      provider,
      hasKey: Boolean(key) || local,
      masked: key ? mask(key) : local ? "local" : null,
      enabled: enabledKeys[provider] !== false,
    });
  }
  return rows;
}

export async function saveKey(
  provider: AgentProviderId,
  key: string,
): Promise<OkResult> {
  const catalog = assistantCatalog(provider);
  const trimmed = key.trim();
  if ((isCliProvider(provider) || provider === "apple") && trimmed)
    return {
      ok: false,
      error:
        provider === "apple"
          ? "Apple Intelligence doesn't use a key."
          : "Sign in through the CLI instead of entering an API key.",
    };
  if (!trimmed && catalog?.needsKey) {
    return { ok: false, error: "Paste a key first." };
  }
  const check = await verifyKey(provider, trimmed);
  if (!check.ok) return check;
  if (trimmed) await setSecret(accountFor(provider), trimmed);
  const prefs = await getPrefs();
  await setPrefs({
    agent: {
      enabledKeys: { ...prefs.agent.enabledKeys, [provider]: true },
      languageModel: prefs.agent.languageModel || provider,
      addedProviders: listedProviders(
        prefs.agent.addedProviders ?? [],
        provider,
      ),
      connectedLocalProviders: {
        ...prefs.agent.connectedLocalProviders,
        [provider]: catalog?.local === true,
      },
    },
  });
  return { ok: true };
}

export async function removeKey(provider: AgentProviderId): Promise<OkSuccess> {
  await deleteSecret(accountFor(provider));
  const prefs = await getPrefs();
  await setPrefs({
    agent: {
      enabledKeys: { ...prefs.agent.enabledKeys, [provider]: false },
      addedProviders: withoutProvider(
        prefs.agent.addedProviders ?? [],
        provider,
      ),
      connectedLocalProviders: {
        ...prefs.agent.connectedLocalProviders,
        [provider]: false,
      },
    },
  });
  return { ok: true };
}

export async function setKeyEnabled(
  provider: AgentProviderId,
  enabled: boolean,
): Promise<OkSuccess> {
  const prefs = await getPrefs();
  await setPrefs({
    agent: {
      enabledKeys: { ...prefs.agent.enabledKeys, [provider]: enabled },
      connectedLocalProviders: {
        ...prefs.agent.connectedLocalProviders,
        [provider]: isLocalProviderConnected(provider, prefs.agent),
      },
    },
  });
  return { ok: true };
}

export async function keyFor(
  provider: AgentProviderId,
): Promise<string | null> {
  if (isCliProvider(provider) || provider === "apple") return null;
  return getSecret(accountFor(provider));
}

export async function verifyKey(
  provider: AgentProviderId,
  key: string,
): Promise<OkResult> {
  const prefs = await getPrefs();
  return checkProviderKey({
    provider,
    key,
    ollamaBaseUrl: prefs.agent.ollamaBaseUrl,
    lmstudioBaseUrl: prefs.agent.lmstudioBaseUrl,
    azureResourceName: prefs.agent.azureResourceName,
  });
}

export async function listProviderModels(
  provider: AgentProviderId,
): Promise<ProviderModelsResult> {
  if (provider === "apple") {
    const status = await appleStatus();
    if (!status.ok) return { ...status, models: [] };
    return {
      ok: true,
      models: [
        {
          id: "system",
          name: "Apple Intelligence",
          description: "Runs on your Mac. Text only.",
          contextWindow: status.contextSize,
          modelCapabilities: {
            text: true,
            vision: false,
            audio: false,
            tools: true,
          },
        },
      ],
    };
  }
  if (isCliProvider(provider)) {
    const check = await checkCliConnection(provider);
    if (!check.ok) return { ...check, models: [] };
    const modelCapabilities = {
      text: true,
      vision: false,
      audio: false,
      tools: true,
    };
    const listed = await listCliModels(provider).catch(() => []);
    return {
      ok: true,
      models: [
        {
          id: "default",
          name: assistantCatalog(provider)?.name ?? provider,
          description: "Uses your local CLI sign-in and subscription limits.",
          modelCapabilities,
        },
        ...listed.map((model) => ({ ...model, modelCapabilities })),
      ],
    };
  }
  const catalog = assistantCatalog(provider);
  const local = catalog?.local === true;
  const publicCatalog = local ? { models: [] } : await loadModelCatalog();
  const prefs = await getPrefs();
  const key = (await getSecret(accountFor(provider))) ?? "";
  if (!key && !local) {
    const models = catalogModelsForProvider(provider, publicCatalog.models);
    return publicCatalog.error
      ? { ok: false, models, error: publicCatalog.error }
      : { ok: true, models };
  }
  const fetched = await fetchProviderModels({
    provider,
    key,
    ollamaBaseUrl: prefs.agent.ollamaBaseUrl,
    lmstudioBaseUrl: prefs.agent.lmstudioBaseUrl,
    azureResourceName: prefs.agent.azureResourceName,
  });
  if (!fetched.ok)
    return {
      ok: false,
      models: catalogModelsForProvider(provider, publicCatalog.models),
      error: fetched.error,
    };
  return {
    ok: true,
    models: catalogModelsForProvider(
      provider,
      publicCatalog.models,
      modelsFromProviderResponse(provider, fetched.json),
    ),
    warning: publicCatalog.error,
  };
}

export async function listAvailableModels(): Promise<{
  providers: Array<ProviderModelsResult & { provider: AgentProviderId }>;
}> {
  const prefs = await getPrefs();
  const rows = await listKeys();
  const connected = rows.filter((row) => row.hasKey && row.enabled);
  const providers = await Promise.all(
    connected.map(
      async (
        row,
      ): Promise<ProviderModelsResult & { provider: AgentProviderId }> => {
        const listed = await listProviderModels(row.provider);
        const available = listed.models.filter(
          (model) => model.available !== false,
        );
        const models = modelsForChooser(
          available,
          prefs.agent.visibleModelIds?.[row.provider] ?? [
            ...available.map((model) => model.id),
            ...(prefs.agent.customModelIds?.[row.provider] ?? []),
          ],
        );
        if (listed.ok) return { provider: row.provider, ...listed, models };
        return models.length > 0
          ? { provider: row.provider, ok: true, models, warning: listed.error }
          : { provider: row.provider, ...listed, models };
      },
    ),
  );
  return { providers };
}

type ProviderConnection = {
  provider: AgentProviderId;
  key: string;
  ollamaBaseUrl: string;
  lmstudioBaseUrl: string;
  azureResourceName: string;
};

type ModelDiscoveryResult =
  | { ok: true; json: JsonValue }
  | { ok: false; error: string; unsupported?: boolean };

const jsonObject = z.record(z.string(), z.json());
const ollamaModelDetail = z.object({
  capabilities: z.array(z.string()),
});

function ollamaShowUrl(modelsUrl: string): string {
  const url = new URL(modelsUrl);
  url.pathname = url.pathname.replace(/\/v1\/models\/?$/, "/api/show");
  url.search = "";
  return url.toString();
}

async function withOllamaModelDetails(
  rows: JsonValue[],
  modelsUrl: string,
  headers: Record<string, string>,
  signal: AbortSignal,
  fetcher: typeof fetch,
): Promise<JsonValue[]> {
  const url = ollamaShowUrl(modelsUrl);
  return Promise.all(
    rows.map(async (row) => {
      const parsedRow = jsonObject.safeParse(row);
      const id = z.string().min(1).safeParse(parsedRow.data?.id);
      if (!parsedRow.success || !id.success) return row;
      try {
        const response = await fetcher(url, {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ model: id.data }),
          signal,
        });
        if (!response.ok) return row;
        const detail = ollamaModelDetail.safeParse(await response.json());
        return detail.success
          ? { ...parsedRow.data, capabilities: detail.data.capabilities }
          : row;
      } catch {
        return row;
      }
    }),
  );
}

// vLLM's /v1/models reports neither capabilities nor architecture (and
// its server-info endpoints are not exposed by default), so the listing
// alone never says whether a model accepts images. A 1-token chat
// completion carrying a tiny inline image is the only signal the API
// offers: a vision model counts the image in
// usage.prompt_tokens_details.multimodal_tokens, while a text-only model
// rejects the request.
const VLLM_VISION_PROBE_IMAGE =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAF0lEQVR4nGP4z8BAEiJN9aiGUQ1DSgMAkPn/Afnh+ngAAAAASUVORK5CYII=";
const VLLM_PROBE_TTL_MS = 30 * 60_000;
const vllmVisionProbeCache = new Map<string, { vision: boolean; at: number }>();

const vllmChatImageTokens = z
  .object({
    usage: z
      .object({
        prompt_tokens_details: z
          .object({
            multimodal_tokens: z.record(z.string(), z.number()),
          })
          .nullish(),
      })
      .nullish(),
  })
  .nullish();

async function probeVllmVision(
  chatUrl: string,
  modelId: string,
  headers: Record<string, string>,
  signal: AbortSignal,
  fetcher: typeof fetch,
): Promise<boolean | undefined> {
  try {
    const response = await fetcher(chatUrl, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        model: modelId,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "What color is this square?" },
              {
                type: "image_url",
                image_url: { url: VLLM_VISION_PROBE_IMAGE },
              },
            ],
          },
        ],
        max_tokens: 1,
        stream: false,
      }),
      signal,
    });
    if (!response.ok) {
      // A 4xx means this model refused image input; a 5xx may be
      // transient, so do not pin that outcome in the cache.
      return response.status < 500 ? false : undefined;
    }
    const parsed = vllmChatImageTokens.safeParse(await response.json());
    return (
      (parsed?.data?.usage?.prompt_tokens_details?.multimodal_tokens?.image ??
        0) > 0
    );
  } catch {
    return undefined;
  }
}

const vllmProbeRow = z.object({
  id: z.string().min(1).catch(""),
  owned_by: z.string().catch(""),
  capabilities: declaredLocalModelCapabilities.optional().catch(undefined),
  architecture: z
    .object({
      input_modalities: z.array(z.string()).catch([]),
    })
    .optional()
    .catch(undefined),
});

function vllmVisionProbeTarget(
  row: JsonValue,
): { id: string; record: Record<string, JsonValue> } | null {
  const record = jsonObject.safeParse(row);
  if (!record.success) return null;
  const fields = vllmProbeRow.safeParse(record.data);
  if (!fields.success) return null;
  const { id, owned_by: ownedBy, capabilities, architecture } = fields.data;
  if (ownedBy !== "vllm" || !id || SKIP.test(id)) return null;
  // Rows that already declare capabilities or llama.cpp modalities are
  // classified by modelsFromProviderResponse, so never probe them.
  if (capabilities !== undefined) return null;
  if (architecture?.input_modalities.length) return null;
  return { id, record: record.data };
}

async function withVllmModelDetails(
  rows: JsonValue[],
  modelsUrl: string,
  headers: Record<string, string>,
  signal: AbortSignal,
  fetcher: typeof fetch,
  now: () => number = Date.now,
): Promise<JsonValue[]> {
  const targets = rows.map((row) => vllmVisionProbeTarget(row));
  if (!targets.some((target) => target !== null)) return rows;
  const chatUrl = modelsUrl.replace(/\/models\/?$/, "/chat/completions");
  return Promise.all(
    rows.map(async (row, index) => {
      const target = targets[index];
      if (!target) return row;
      const stamp = now();
      const cacheKey = `${chatUrl}::${target.id}`;
      const cached = vllmVisionProbeCache.get(cacheKey);
      if (cached && stamp - cached.at < VLLM_PROBE_TTL_MS) return row;
      const vision = await probeVllmVision(
        chatUrl,
        target.id,
        headers,
        signal,
        fetcher,
      );
      if (vision === undefined) return row;
      if (vllmVisionProbeCache.size > 200) vllmVisionProbeCache.clear();
      vllmVisionProbeCache.set(cacheKey, { vision, at: stamp });
      return {
        ...target.record,
        capabilities: vision ? ["completion", "vision"] : ["completion"],
      };
    }),
  );
}

export async function checkProviderKey(
  input: ProviderConnection,
  fetcher: typeof fetch = fetch,
): Promise<OkResult> {
  if (input.provider === "apple")
    return appleStatus().then((status) => (status.ok ? { ok: true } : status));
  if (isCliProvider(input.provider)) return checkCliConnection(input.provider);
  if (input.provider === "openrouter") {
    try {
      const response = await fetcher(OPENROUTER_KEY_URL, {
        headers: { Authorization: `Bearer ${input.key}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (response.ok) return { ok: true };
      if (response.status === 401 || response.status === 403) {
        return {
          ok: false,
          error:
            "OpenRouter rejected this key or its permissions. Check it in Settings.",
        };
      }
      return {
        ok: false,
        error: `Could not verify the OpenRouter key (HTTP ${response.status}). Try again later.`,
      };
    } catch (error) {
      return {
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "Could not verify the OpenRouter key. Try again later.",
      };
    }
  }
  const fetched = await fetchProviderModels(input, fetcher);
  if (fetched.ok || fetched.unsupported) return { ok: true };
  return { ok: false, error: fetched.error };
}

export async function fetchProviderModels(
  input: ProviderConnection,
  fetcher: typeof fetch = fetch,
): Promise<ModelDiscoveryResult> {
  const { provider, key } = input;
  const name = assistantCatalog(provider)?.provider ?? provider;
  let url: string;
  const headers: Record<string, string> = {};
  if (provider === "anthropic") {
    url = "https://api.anthropic.com/v1/models";
    headers["x-api-key"] = key;
    headers["anthropic-version"] = "2023-06-01";
  } else if (provider === "gemini") {
    url = "https://generativelanguage.googleapis.com/v1beta/models";
    headers["x-goog-api-key"] = key;
  } else if (provider === "deepseek") {
    url = "https://api.deepseek.com/v1/models";
    headers.Authorization = `Bearer ${key}`;
  } else if (provider === "azure") {
    const resource = input.azureResourceName.trim();
    if (!resource) return { ok: false, error: "Enter a resource name first." };
    url = `https://${resource}.openai.azure.com/openai/v1/models`;
    if (key) headers["api-key"] = key;
  } else if (provider === "openrouter") {
    url = OPENROUTER_MODELS_URL;
    if (key) headers.Authorization = `Bearer ${key}`;
  } else if (isOpenAIModelsProvider(provider)) {
    const base = OPENAI_MODELS[provider];
    url = `${base.replace(/\/$/, "")}/models`;
    if (key) headers.Authorization = `Bearer ${key}`;
  } else {
    const base =
      provider === "ollama"
        ? input.ollamaBaseUrl
        : provider === "lmstudio"
          ? input.lmstudioBaseUrl
          : undefined;
    if (!base) return { ok: false, error: "Enter an API base URL first." };
    url = `${base.replace(/\/$/, "")}/models`;
    if (key) headers.Authorization = `Bearer ${key}`;
  }
  const rows: JsonValue[] = [];
  const cursors = new Set<string>();
  const endpoint = url;
  const signal = AbortSignal.timeout(10_000);
  try {
    while (true) {
      const res = await fetcher(url, { headers, signal });
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
          return {
            ok: false,
            error: `${name} rejected this key or its permissions. Check it in Settings.`,
          };
        }
        const unsupported =
          (provider === "lmstudio" ||
            provider === "azure" ||
            provider === "perplexity" ||
            provider === "baseten") &&
          [404, 405, 501].includes(res.status);
        return {
          ok: false,
          unsupported,
          error: unsupported
            ? `${name} does not list models. Add a custom model ID.`
            : `Could not load models from ${name} (HTTP ${res.status}). Try again later.`,
        };
      }
      try {
        const json: unknown = await res.json();
        const page =
          provider === "gemini"
            ? z
                .object({
                  models: z.array(z.json()),
                  nextPageToken: z.string().optional(),
                })
                .parse(json)
            : z
                .object({
                  data: z.array(z.json()),
                  has_more: z.boolean().optional(),
                  last_id: z.string().nullable().optional(),
                })
                .parse(json);
        rows.push(...("models" in page ? page.models : page.data));
        const cursor =
          "models" in page
            ? page.nextPageToken
            : provider === "anthropic" && page.has_more
              ? page.last_id
              : undefined;
        if (
          provider === "anthropic" &&
          "has_more" in page &&
          page.has_more &&
          !cursor
        )
          throw new Error("Missing pagination cursor");
        if (!cursor) {
          const discoveredRows =
            provider === "ollama"
              ? await withOllamaModelDetails(
                  rows,
                  endpoint,
                  headers,
                  signal,
                  fetcher,
                )
              : provider === "lmstudio"
                ? await withVllmModelDetails(
                    rows,
                    endpoint,
                    headers,
                    signal,
                    fetcher,
                  )
                : rows;
          return {
            ok: true,
            json:
              provider === "gemini"
                ? { models: discoveredRows }
                : { data: discoveredRows },
          };
        }
        if (cursors.has(cursor)) throw new Error("Repeated pagination cursor");
        cursors.add(cursor);
        const next = new URL(endpoint);
        next.searchParams.set(
          provider === "gemini" ? "pageToken" : "after_id",
          cursor,
        );
        url = next.toString();
      } catch {
        return { ok: false, error: `${name} returned an invalid model list.` };
      }
    }
  } catch {
    return {
      ok: false,
      error: `Could not reach ${name}. Check the network and try again.`,
    };
  }
}
