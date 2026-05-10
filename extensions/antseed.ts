/**
 * pi-antseed
 *
 * Registers the AntSeed local buyer proxy (default http://localhost:8377) as a
 * protocol-aware pi provider. The extension reads AntSeed peer metadata from
 * `/_antseed/peers`, discovers which API protocol each service advertises, and
 * dispatches each request through the matching pi-ai provider implementation.
 *
 * Reputation is sourced from the buyer's local state file (default
 * `~/.antseed/buyer.state.json`) because the HTTP `/_antseed/peers` payload
 * omits `onChainReputationScore`. See `apps/cli/src/proxy/buyer-proxy.ts`
 * (`_persistPeersToState` writes it; `_handleControlPlane` does not surface
 * it on the wire).
 *
 * Configuration:
 *   ANTSEED_BASE_URL          proxy root or /v1 URL (default http://localhost:8377)
 *   ANTSEED_API_KEY           only needed if you put auth in front of the proxy
 *   ANTSEED_MODELS            optional comma-separated allow-list of service IDs
 *   ANTSEED_DATA_DIR          directory holding buyer.state.json (default ~/.antseed)
 *   ANTSEED_BUYER_STATE_FILE  explicit path to buyer.state.json (overrides ANTSEED_DATA_DIR)
 */
import type { ExtensionAPI, ProviderModelConfig } from "@mariozechner/pi-coding-agent";
import { getApiProvider, type Api, type Context, type Model, type SimpleStreamOptions } from "@mariozechner/pi-ai";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

type AntseedApi = Extract<Api, "anthropic-messages" | "openai-completions" | "openai-responses">;
type AntseedNetworkProtocol = AntseedApi | "openai-chat-completions";
type AntseedAutoApi = "antseed-network";

const AUTO_API: AntseedAutoApi = "antseed-network";
const BASE_URL = process.env.ANTSEED_BASE_URL ?? "http://localhost:8377";
const DISCOVERY_TIMEOUT_MS = 4000;
const PIN_PEER_HEADER = "x-antseed-pin-peer";

interface ModelSpec {
	id: string;
	name: string;
	reasoning: boolean;
	input: ("text" | "image")[];
	contextWindow: number;
	maxTokens: number;
}

interface PeerRecord {
	peerId?: unknown;
	displayName?: unknown;
	providerServiceApiProtocols?: unknown;
	providerServiceCategories?: unknown;
	// AntSeed exposes two reputation numbers on each peer:
	//   onChainReputationScore — derived from on-chain receipts (canonical)
	//   reputationScore        — locally tracked / off-chain fallback
	// Match the convention used in @antseed/router-core's peer-scorer:
	// prefer on-chain when present, fall back to off-chain.
	onChainReputationScore?: unknown;
	reputationScore?: unknown;
}

interface AntseedRoute {
	api: AntseedApi;
	peerId: string;
	peerName: string | null;
	serviceId: string;
	reputation: number;
	categories: Set<string>;
}

const DEFAULT_CONTEXT_WINDOW = 400_000;
const DEFAULT_MAX_TOKENS = 16_384;

let modelRoutes = new Map<string, AntseedRoute>();
// peerId (lowercased) → effective reputation, sourced from buyer.state.json.
// Populated once per discovery cycle in discoverModels().
let buyerStateReputations = new Map<string, number>();

function stripTrailingSlashes(url: string): string {
	return url.replace(/\/+$/, "");
}

function proxyRootUrl(): string {
	return stripTrailingSlashes(BASE_URL.trim() || "http://localhost:8377").replace(/\/v1$/i, "");
}

function openAiBaseUrl(): string {
	return `${proxyRootUrl()}/v1`;
}

function baseUrlForApi(api: AntseedApi): string {
	return api === "anthropic-messages" ? proxyRootUrl() : openAiBaseUrl();
}

function peersUrl(): string {
	return `${proxyRootUrl()}/_antseed/peers`;
}

function serviceKey(service: string): string {
	return service.trim().toLowerCase();
}

function makeModel(id: string, route: AntseedRoute): ModelSpec {
	return {
		id,
		name: routeDisplayName(route),
		reasoning: supportsReasoning(route),
		input: supportsImages(route) ? ["text", "image"] : ["text"],
		contextWindow: inferContextWindow(route.serviceId),
		maxTokens: DEFAULT_MAX_TOKENS,
	};
}

function routeDisplayName(route: AntseedRoute): string {
	const peerLabel = route.peerName
		? `${route.peerName} (${route.peerId.slice(0, 8)})`
		: route.peerId.slice(0, 12);
	const rep = Number.isFinite(route.reputation) ? ` · rep ${displayReputation(route.reputation)}` : "";
	return `${route.serviceId} @ ${peerLabel}${rep} (AntSeed)`;
}

function displayReputation(score: number): number {
	// Buyer-state on-chain scores are floats (e.g. 78.86273751647683). Round to
	// an integer so model ids and display names stay readable.
	return Math.round(score);
}

function supportsReasoning(route: AntseedRoute): boolean {
	return route.api !== "openai-completions" && hasAnyCategory(route, ["reasoning", "thinking"]);
}

function supportsImages(route: AntseedRoute): boolean {
	return hasAnyCategory(route, ["multimodal", "vision", "image", "images"]);
}

function hasAnyCategory(route: AntseedRoute, categories: string[]): boolean {
	return categories.some((category) => route.categories.has(category));
}

function inferContextWindow(id: string): number {
	const match = id.toLowerCase().match(/(?:^|[-_.])(\d+(?:\.\d+)?)([km])(?:$|[-_.])/);
	if (!match) return DEFAULT_CONTEXT_WINDOW;

	const value = Number(match[1]);
	if (!Number.isFinite(value) || value <= 0) return DEFAULT_CONTEXT_WINDOW;
	return Math.round(value * (match[2] === "m" ? 1_000_000 : 1_000));
}

function toProviderModel(model: ModelSpec): ProviderModelConfig {
	return {
		...model,
		api: AUTO_API,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function isNetworkProtocol(value: unknown): value is AntseedNetworkProtocol {
	return value === "anthropic-messages"
		|| value === "openai-responses"
		|| value === "openai-chat-completions"
		|| value === "openai-completions";
}

function toPiApi(protocol: AntseedNetworkProtocol): AntseedApi {
	return protocol === "openai-chat-completions" ? "openai-completions" : protocol;
}

function chooseApi(protocols: unknown[]): AntseedApi | null {
	const supported = protocols.filter(isNetworkProtocol);
	if (supported.length === 0) return null;

	// Prefer lossless/stateful protocols when a seller advertises multiple options.
	for (const protocol of ["openai-responses", "anthropic-messages", "openai-chat-completions", "openai-completions"] as const) {
		if (supported.includes(protocol)) return toPiApi(protocol);
	}
	return toPiApi(supported[0]!);
}

const PEER_ID_PREFIX_LENGTH = 12;
const PEER_NAME_SLUG_MAX = 24;

function slugifyPeerName(name: string): string {
	return name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, PEER_NAME_SLUG_MAX);
}

function routeModelId(service: string, peerId: string, peerName: string | null, reputation: number): string {
	const slug = peerName ? slugifyPeerName(peerName) : "";
	const slugSegment = slug ? `-${slug}` : "";
	const repSegment = Number.isFinite(reputation) ? `-rep${displayReputation(reputation)}` : "";
	return `${service}@${peerId.slice(0, PEER_ID_PREFIX_LENGTH)}${slugSegment}${repSegment}`;
}

function setRoute(
	routes: Map<string, AntseedRoute>,
	peerId: string,
	peerName: string | null,
	service: string,
	api: AntseedApi,
	reputation: number,
	categories: Set<string>,
): void {
	const key = serviceKey(routeModelId(service, peerId, peerName, reputation));
	const existing = routes.get(key);
	if (!existing) {
		routes.set(key, { api, peerId, peerName, serviceId: service, reputation, categories });
		return;
	}

	for (const category of categories) existing.categories.add(category);
	if (routeRank(api) < routeRank(existing.api)) {
		existing.api = api;
	}
}

function routeRank(api: AntseedApi): number {
	if (api === "openai-responses") return 0;
	if (api === "anthropic-messages") return 1;
	return 2;
}

function peerReputation(peer: PeerRecord, peerId: string): number {
	// Precedence:
	//   1. buyer.state.json (canonical: contains the real onChainReputationScore
	//      that the buyer-proxy computed locally — the HTTP /_antseed/peers
	//      payload deliberately omits it).
	//   2. peer.onChainReputationScore from the HTTP payload (in case a future
	//      buyer-proxy revision starts surfacing it).
	//   3. peer.reputationScore (off-chain fallback).
	//   4. NEGATIVE_INFINITY — pushes unrated peers to the bottom.
	const fromState = buyerStateReputations.get(peerId);
	if (typeof fromState === "number" && Number.isFinite(fromState)) {
		return fromState;
	}
	if (typeof peer.onChainReputationScore === "number" && Number.isFinite(peer.onChainReputationScore)) {
		return peer.onChainReputationScore;
	}
	if (typeof peer.reputationScore === "number" && Number.isFinite(peer.reputationScore)) {
		return peer.reputationScore;
	}
	return Number.NEGATIVE_INFINITY;
}

function peerDisplayName(peer: PeerRecord): string | null {
	if (typeof peer.displayName !== "string") return null;
	const trimmed = peer.displayName.trim();
	return trimmed.length > 0 ? trimmed : null;
}

function collectRoutes(peer: PeerRecord, routes: Map<string, AntseedRoute>): void {
	const peerId = typeof peer.peerId === "string" ? peer.peerId.trim().toLowerCase() : "";
	if (!/^[0-9a-f]{40}$/.test(peerId)) return;

	const matrix = asRecord(peer.providerServiceApiProtocols);
	if (!matrix) return;

	const reputation = peerReputation(peer, peerId);
	const peerName = peerDisplayName(peer);

	for (const [provider, rawEntry] of Object.entries(matrix)) {
		const services = asRecord(asRecord(rawEntry)?.services);
		if (!services) continue;

		for (const [service, rawProtocols] of Object.entries(services)) {
			if (!Array.isArray(rawProtocols)) continue;
			const api = chooseApi(rawProtocols);
			if (api) setRoute(routes, peerId, peerName, service, api, reputation, serviceCategories(peer, provider, service));
		}
	}
}

function serviceCategories(peer: PeerRecord, provider: string, service: string): Set<string> {
	const categories = asRecord(asRecord(peer.providerServiceCategories)?.[provider])?.services;
	const raw = asRecord(categories)?.[service];
	return new Set(
		Array.isArray(raw)
			? raw.filter((category): category is string => typeof category === "string").map((category) => category.trim().toLowerCase()).filter(Boolean)
			: [],
	);
}

async function fetchJson(url: string): Promise<unknown> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), DISCOVERY_TIMEOUT_MS);
	try {
		const response = await fetch(url, { signal: controller.signal });
		if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
		return await response.json();
	} finally {
		clearTimeout(timeout);
	}
}

function buyerStateFilePath(): string {
	const explicit = process.env.ANTSEED_BUYER_STATE_FILE?.trim();
	if (explicit) return explicit;
	const dataDir = process.env.ANTSEED_DATA_DIR?.trim() || join(homedir(), ".antseed");
	return join(dataDir, "buyer.state.json");
}

async function loadBuyerStateReputations(): Promise<Map<string, number>> {
	// Best-effort: if the file is missing or unreadable (e.g. extension is
	// pointed at a remote proxy with no local state), return empty and let the
	// HTTP payload supply whatever it has.
	const path = buyerStateFilePath();
	let raw: string;
	try {
		raw = await readFile(path, "utf-8");
	} catch {
		return new Map();
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		console.warn(`[pi-antseed] Failed to parse ${path}: ${err instanceof Error ? err.message : String(err)}`);
		return new Map();
	}

	const peers = Array.isArray(asRecord(parsed)?.discoveredPeers)
		? (asRecord(parsed)!.discoveredPeers as unknown[])
		: [];

	const map = new Map<string, number>();
	for (const entry of peers) {
		const record = asRecord(entry);
		if (!record) continue;
		const peerId = typeof record.peerId === "string" ? record.peerId.trim().toLowerCase() : "";
		if (!/^[0-9a-f]{40}$/.test(peerId)) continue;

		// Mirror the precedence used by @antseed/router-core's peer-scorer:
		// on-chain wins, off-chain fallback. We don't run
		// computeOnChainReputationScore() here — the buyer-proxy already
		// persisted the result in onChainReputationScore.
		const onChain = record.onChainReputationScore;
		if (typeof onChain === "number" && Number.isFinite(onChain)) {
			map.set(peerId, onChain);
			continue;
		}
		const off = record.reputationScore;
		if (typeof off === "number" && Number.isFinite(off)) {
			map.set(peerId, off);
		}
	}
	return map;
}

async function fetchNetworkRoutes(): Promise<Map<string, AntseedRoute>> {
	const body = asRecord(await fetchJson(peersUrl()));
	const peers = Array.isArray(body?.peers) ? body.peers as PeerRecord[] : [];
	const routes = new Map<string, AntseedRoute>();

	for (const peer of peers) {
		collectRoutes(peer, routes);
	}
	return routes;
}

function configuredModelAllowList(): Set<string> | null {
	const raw = process.env.ANTSEED_MODELS;
	if (!raw) return null;
	return new Set(raw.split(",").map((id) => serviceKey(id)).filter(Boolean));
}

async function discoverModels(): Promise<ModelSpec[]> {
	// Refresh reputation map BEFORE collecting routes — collectRoutes ->
	// peerReputation reads buyerStateReputations during route construction.
	buyerStateReputations = await loadBuyerStateReputations();
	const routes = await fetchNetworkRoutes();
	const allowList = configuredModelAllowList();
	if (allowList) {
		for (const [key, route] of [...routes.entries()]) {
			if (!allowList.has(key) && !allowList.has(serviceKey(route.serviceId))) routes.delete(key);
		}
	}

	modelRoutes = routes;
	return sortRoutesByReputation([...routes.entries()]).map(([id, route]) => makeModel(id, route));
}

function sortRoutesByReputation(entries: [string, AntseedRoute][]): [string, AntseedRoute][] {
	// Primary: reputation descending (highest first; unknown rep falls to the bottom).
	// Secondary: keep all of a peer's services together so the list reads as
	//   <peer>
	//     service A
	//     service B
	//   <next peer>
	//     ...
	// Tertiary: alphabetic service id within a peer.
	return entries.sort(([, a], [, b]) => {
		if (a.reputation !== b.reputation) return b.reputation - a.reputation;
		const peerLabelA = a.peerName ?? a.peerId;
		const peerLabelB = b.peerName ?? b.peerId;
		if (peerLabelA !== peerLabelB) return peerLabelA.localeCompare(peerLabelB);
		return a.serviceId.localeCompare(b.serviceId);
	});
}

function routeForModel(id: string): AntseedRoute {
	const route = modelRoutes.get(serviceKey(id));
	if (!route) {
		throw new Error(`[pi-antseed] No AntSeed route found for model ${id}. Run /reload to refresh network metadata.`);
	}
	return route;
}

function routedModel<TApi extends AntseedApi>(model: Model<Api>, route: AntseedRoute): Model<TApi> {
	return {
		...model,
		id: route.serviceId,
		api: route.api,
		baseUrl: baseUrlForApi(route.api),
		reasoning: route.api === "openai-completions" ? false : model.reasoning,
	} as Model<TApi>;
}

function routedOptions(route: AntseedRoute, options?: SimpleStreamOptions): SimpleStreamOptions {
	return {
		...options,
		headers: {
			...options?.headers,
			[PIN_PEER_HEADER]: route.peerId,
		},
	};
}

function streamAntseed(model: Model<Api>, context: Context, options?: SimpleStreamOptions) {
	const route = routeForModel(model.id);
	const provider = getApiProvider(route.api);
	if (!provider) throw new Error(`[pi-antseed] No pi-ai provider registered for API ${route.api}`);
	return provider.streamSimple(routedModel(model, route), context, routedOptions(route, options));
}

export default async function (pi: ExtensionAPI) {
	try {
		const models = await discoverModels();
		if (models.length === 0) {
			console.warn("[pi-antseed] No protocol-bearing services found in /_antseed/peers. Start the buyer proxy, wait for peers, and run `/reload`.");
			return;
		}

		pi.registerProvider("antseed", {
			baseUrl: proxyRootUrl(),
			apiKey: process.env.ANTSEED_API_KEY ? "ANTSEED_API_KEY" : "antseed-local",
			api: AUTO_API,
			streamSimple: streamAntseed,
			authHeader: true,
			models: models.map(toProviderModel),
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.warn(`[pi-antseed] Failed to read AntSeed network metadata from ${peersUrl()}: ${message}`);
	}
}
