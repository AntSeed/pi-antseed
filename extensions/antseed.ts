/**
 * pi-antseed
 *
 * Registers the AntSeed local buyer proxy (http://localhost:8377/v1) as a
 * model provider in pi. AntSeed exposes an OpenAI-compatible endpoint, so we
 * just point pi at it via `openai-completions`.
 *
 * Prerequisites (see README.md):
 *   1. `antseed buyer start` is running.
 *   2. You have funded deposits OR an active subscription.
 *   3. Either pin a peer with `antseed buyer connection set --peer <id>`,
 *      or configure a router so the buyer can route to peers automatically.
 *
 * Configuration (env):
 *   ANTSEED_BASE_URL  override the proxy URL (default http://localhost:8377/v1)
 *   ANTSEED_API_KEY   only needed if you put auth in front of the proxy
 *   ANTSEED_MODELS    comma-separated model IDs to override the built-in list
 *                     (e.g. "minimax-m2.7,gpt-5.5")
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const BASE_URL = process.env.ANTSEED_BASE_URL ?? "http://localhost:8377/v1";

interface ModelSpec {
	id: string;
	name: string;
	reasoning: boolean;
	input: ("text" | "image")[];
	contextWindow: number;
	maxTokens: number;
}

// Models currently advertised by AntSeed sellers on this machine. The public
// docs only feature the open-weights MiniMax models; closed models are kept
// here for local use. Override at runtime via ANTSEED_MODELS.
const DEFAULT_MODELS: ModelSpec[] = [
	{
		id: "minimax-m2.7",
		name: "MiniMax M2.7 (AntSeed, open weights)",
		reasoning: true,
		input: ["text"],
		contextWindow: 128_000,
		maxTokens: 8_192,
	},
	{
		id: "minimax-m2.7-highspeed",
		name: "MiniMax M2.7 HighSpeed (AntSeed, open weights)",
		reasoning: false,
		input: ["text"],
		contextWindow: 128_000,
		maxTokens: 8_192,
	},
	{
		id: "minimax-m2.5",
		name: "MiniMax M2.5 (AntSeed, open weights)",
		reasoning: false,
		input: ["text"],
		contextWindow: 128_000,
		maxTokens: 8_192,
	},
	{
		id: "gpt-5.4",
		name: "GPT-5.4 (AntSeed)",
		reasoning: false,
		input: ["text", "image"],
		contextWindow: 200_000,
		maxTokens: 16_384,
	},
	{
		id: "gpt-5.5",
		name: "GPT-5.5 (AntSeed)",
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 200_000,
		maxTokens: 16_384,
	},
];

function resolveModels(): ModelSpec[] {
	const override = process.env.ANTSEED_MODELS;
	if (!override) return DEFAULT_MODELS;
	return override
		.split(",")
		.map((id) => id.trim())
		.filter(Boolean)
		.map((id) => {
			const found = DEFAULT_MODELS.find((m) => m.id === id);
			return (
				found ?? {
					id,
					name: `${id} (AntSeed)`,
					reasoning: false,
					input: ["text"],
					contextWindow: 128_000,
					maxTokens: 8_192,
				}
			);
		});
}

export default function (pi: ExtensionAPI) {
	pi.registerProvider("antseed", {
		baseUrl: BASE_URL,
		// AntSeed doesn't require an API key on localhost. pi-ai still asks for
		// one, so default to a literal placeholder unless the user supplies one.
		apiKey: process.env.ANTSEED_API_KEY ? "ANTSEED_API_KEY" : "antseed-local",
		api: "openai-completions",
		authHeader: true,
		models: resolveModels().map((m) => ({
			...m,
			// Pricing is metered per peer/service by AntSeed itself, not pi.
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		})),
	});
}
