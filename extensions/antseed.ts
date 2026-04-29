/**
 * pi-antseed
 *
 * Registers the AntSeed local buyer proxy (default http://localhost:8377/v1)
 * as a model provider in pi. AntSeed exposes Anthropic Messages, OpenAI Chat
 * Completions, and OpenAI Responses interchangeably via @antseed/api-adapter;
 * we point pi at Chat Completions because that's the hub format.
 *
 * A small built-in model seed list is registered synchronously so pi can honor
 * `defaultProvider: "antseed"` / `defaultModel` during startup. The provider is
 * then refreshed from the pinned peer's `/v1/models` endpoint, so this extension
 * stays accurate as you switch peers with `antseed buyer connection set --peer
 * <id>`. Reload pi (`/reload`) after changing peers to refresh the list.
 *
 * Prerequisites (see README.md):
 *   1. `antseed buyer start` is running.
 *   2. ANTSEED_IDENTITY_HEX exported and deposits funded via `antseed payments`.
 *   3. A peer is pinned (`antseed buyer connection set --peer <id>`) or a
 *      router plugin is configured.
 *
 * Configuration (env):
 *   ANTSEED_BASE_URL  override the proxy URL (default http://localhost:8377/v1)
 *   ANTSEED_API_KEY   only needed if you put auth in front of the proxy
 *   ANTSEED_MODELS    comma-separated model IDs to use instead of `/v1/models`
 *                     discovery (e.g. "minimax-m2.7,gpt-5.5")
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const BASE_URL = process.env.ANTSEED_BASE_URL ?? "http://localhost:8377/v1";
const DISCOVERY_TIMEOUT_MS = 4000;

interface ModelSpec {
	id: string;
	name: string;
	reasoning: boolean;
	input: ("text" | "image")[];
	contextWindow: number;
	maxTokens: number;
}

// Hints for well-known model IDs the AntSeed network currently advertises.
// Anything not listed falls back to safe text-only defaults.
const MODEL_HINTS: Record<string, Partial<ModelSpec>> = {
	"gpt-5.4": { input: ["text", "image"], contextWindow: 200_000, maxTokens: 16_384 },
	"gpt-5.5": { input: ["text", "image"], reasoning: true, contextWindow: 200_000, maxTokens: 16_384 },
	"minimax-m2.5": { contextWindow: 128_000, maxTokens: 8_192 },
	"minimax-m2.7": { reasoning: true, contextWindow: 128_000, maxTokens: 8_192 },
	"minimax-m2.7-highspeed": { contextWindow: 128_000, maxTokens: 8_192 },
};

function makeModel(id: string): ModelSpec {
	const hint = MODEL_HINTS[id] ?? {};
	return {
		id,
		name: hint.name ?? `${id} (AntSeed)`,
		reasoning: hint.reasoning ?? false,
		input: hint.input ?? ["text"],
		contextWindow: hint.contextWindow ?? 128_000,
		maxTokens: hint.maxTokens ?? 8_192,
	};
}

async function fetchModelIds(): Promise<string[]> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), DISCOVERY_TIMEOUT_MS);
	try {
		const res = await fetch(`${BASE_URL}/models`, { signal: controller.signal });
		if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
		const body = (await res.json()) as { data?: Array<{ id?: string }> };
		const ids = (body.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === "string" && id.length > 0);
		return ids;
	} finally {
		clearTimeout(timer);
	}
}

function parseModelOverride(): string[] | undefined {
	const override = process.env.ANTSEED_MODELS;
	if (!override) return undefined;
	return override
		.split(",")
		.map((id) => id.trim())
		.filter(Boolean);
}

function mergeModelIds(...groups: Array<string[] | undefined>): string[] {
	return [...new Set(groups.flatMap((group) => group ?? []))];
}

function initialModelIds(): string[] {
	// Pi chooses the default model during startup. Provider registration that happens
	// later from async discovery is too late for that first selection, so register a
	// small synchronous seed list immediately. ANTSEED_MODELS can narrow/override it.
	return parseModelOverride() ?? Object.keys(MODEL_HINTS);
}

async function resolveModels(): Promise<ModelSpec[]> {
	const override = parseModelOverride();
	if (override) return override.map(makeModel);

	const discovered = await fetchModelIds();
	// Keep the synchronous seed list available even if the current peer advertises a
	// partial model list. Requests still go through AntSeed, which will validate
	// whether the pinned peer/service can serve the requested model.
	return mergeModelIds(initialModelIds(), discovered).map(makeModel);
}

function register(pi: ExtensionAPI, models: ModelSpec[]): void {
	pi.registerProvider("antseed", {
		baseUrl: BASE_URL,
		// AntSeed doesn't require an API key on localhost. pi-ai still asks for
		// one, so default to a literal placeholder unless the user supplies one.
		apiKey: process.env.ANTSEED_API_KEY ? "ANTSEED_API_KEY" : "antseed-local",
		api: "openai-completions",
		authHeader: true,
		models: models.map((m) => ({
			...m,
			// Pricing is metered per peer/service by AntSeed itself, not pi.
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		})),
	});
}

export default function (pi: ExtensionAPI) {
	// Register synchronously so Pi can honor defaultProvider/defaultModel during
	// startup. Without this, the provider may not exist yet when Pi picks the
	// initial model, causing new chats to fall back to another provider (e.g. Opus).
	register(pi, initialModelIds().map(makeModel));

	(async () => {
		try {
			const models = await resolveModels();
			if (models.length === 0) {
				console.warn(
					"[pi-antseed] No models advertised by the AntSeed proxy. Pin a peer with " +
						"`antseed buyer connection set --peer <id>` and run `/reload`.",
				);
				return;
			}
			register(pi, models);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			console.warn(
				`[pi-antseed] Failed to discover models from ${BASE_URL}/models: ${message}. ` +
					"Make sure `antseed buyer start` is running, then `/reload`.",
			);
		}
	})();
}
