# pi-antseed

Use [AntSeed](https://antseed.com) as a model provider in [pi](https://shittycodingagent.ai).

AntSeed runs a **local buyer proxy** (default `http://localhost:8377`) that
speaks Anthropic Messages, OpenAI Chat Completions, and OpenAI Responses
interchangeably — the [`@antseed/api-adapter`](https://github.com/AntSeed/antseed/tree/main/packages/api-adapter)
translates between them on the fly, regardless of what the upstream seller
actually speaks. This package registers a protocol-aware pi provider named
`antseed`, so you can switch to AntSeed-routed models with
`/model antseed/<id>` without manually choosing the wire protocol.

---

## Install

```bash
# From GitHub
pi install git:github.com/AntSeed/pi-antseed

# Or try without installing
pi -e git:github.com/AntSeed/pi-antseed

# From a local clone
pi install ./pi-antseed
```

Restart pi (or `/reload`), then pick any discovered AntSeed service/peer route:

```
/model antseed/<service-id>@<peer-prefix>
```

---

## Prerequisites — getting AntSeed wired up

This is the path to a running buyer proxy on `http://localhost:8377`. The
extension reads `/_antseed/peers` from that proxy to learn each service's
network-advertised API protocol.

Sources of truth for the commands below: the [`@antseed/cli`
README](https://github.com/AntSeed/antseed/blob/main/apps/cli/README.md) and
`antseed <cmd> --help`.

### 1. Install the CLI

```bash
npm i -g @antseed/cli
antseed --version
```

The binary is `antseed`. Identity and state live in `~/.antseed/`.

### 2. Set your buyer identity

AntSeed authenticates your node with a secp256k1 private key. Export it before
running any buyer command:

```bash
export ANTSEED_IDENTITY_HEX=<your-private-key-hex>
```

(Persist it in your shell profile or a `.env.local` next to where you run
`antseed`.)

### 3. Fund the buyer with USDC on Base

Launch the local payments portal and deposit USDC from any funded wallet
(MetaMask, Coinbase Wallet, etc.):

```bash
antseed payments    # opens http://localhost:3118
```

The contract's `deposit(buyer, amount)` pulls USDC from the connected wallet
and credits your node — your identity key never has to hold funds.

Check balances any time:

```bash
antseed buyer balance
antseed buyer status
```

### 4. Start the buyer proxy

```bash
antseed buyer start    # proxy on http://localhost:8377
```

Sanity-check that the OpenAI-compatible endpoint is up:

```bash
curl -s http://localhost:8377/v1/models | jq
```

If the list is empty, the proxy is up but not connected to a seller — keep
going.

### 5. Find a peer (seller) to talk to

Browse what's on the network:

```bash
antseed network browse
antseed network browse --services            # one row per (peer, service)
antseed network browse --sort price --top 10
```

Inspect a specific peer (full details — providers, services, on-chain stats):

```bash
antseed network peer 0e49122e76bd8b9ccb2fe10c0088c41ceb608927
```

(`antseed peer <peerId>` also exists for a quick profile-only view.)

### 6. Verify peers are visible to the proxy

The pi extension targets a peer per request, so you do **not** need to pin a
session-wide peer with `antseed buyer connection set`. The proxy must simply see
network peers:

```bash
curl http://localhost:8377/_antseed/peers | jq
```

The response should include `providerServiceApiProtocols` metadata for each
service. The extension uses that metadata to register pi models and send the
selected peer in the `x-antseed-pin-peer` request header.

### 7. Use it in pi

Open the model selector with `Ctrl+L` (or `/model`) and pick any AntSeed route:

```
antseed/<service-id>@<peer-prefix>[-<peer-name>][-rep<score>]
```

For example:

```
antseed/claude-opus-4-5@0e49122e76bd-acme-buyer-rep95
antseed/arcee-trinity-thinking@0e49122e76bd-acme-buyer-rep95
antseed/minimax-m2.7@bbbbbbbbbbbb-rep5
```

The extension reads AntSeed's peer metadata from `/_antseed/peers`, discovers
each service/peer route, registers every route as a selectable pi model, and
appends the peer's `displayName` (slugified) and `reputationScore` to the model
id so they're visible directly in the pi selector. Routes are ordered by peer
reputation, highest first. On each request, the extension sends the peer pin
header (`x-antseed-pin-peer`) and lets the AntSeed proxy select the provider
inside that peer.

If you want to expose only a specific subset of the discovered services, set
`ANTSEED_MODELS`:

```bash
ANTSEED_MODELS="minimax-m2.7,arcee-trinity-thinking" pi
```

Matching is by service id or by full route id (e.g.
`minimax-m2.7@bbbbbbbbbbbb-rep5`).

---

## Configuration

| Env var | Default | Purpose |
| --- | --- | --- |
| `ANTSEED_BASE_URL` | `http://localhost:8377` | Override the buyer proxy URL. Either the root URL or `/v1` URL is accepted; the extension normalizes it per protocol. |
| `ANTSEED_API_KEY` | _(unset)_ | Only needed if you front the proxy with auth. |
| `ANTSEED_MODELS` | all protocol-bearing services from `/_antseed/peers` | Optional comma-separated allow-list of service IDs or full `service@peer-prefix[-name][-rep<score>]` route IDs to register. |

---

## Troubleshooting

- **No `antseed/...` models in pi** — no protocol-bearing services were found
  in `/_antseed/peers`. Make sure `antseed buyer start` is running, peers are
  discoverable with `antseed network browse --services`, then run `/reload`.
- **`Connection state: idle` in `antseed buyer status`** — run
  `antseed buyer start` and keep it running.
- **Insufficient deposits** — `antseed buyer balance` should be > 0; top up
  via `antseed payments`.
- **Identity errors** — make sure `ANTSEED_IDENTITY_HEX` is exported in the
  shell that runs `antseed buyer start`.
- **5xx from the proxy on a real request** — usually means the selected peer
  route has gone offline or no longer offers that service. Re-run
  `antseed network browse --services`, `/reload`, and pick another route.

---

## How it works

`extensions/antseed.ts` registers one provider, `antseed`, with a tiny custom
`streamSimple` dispatcher. At `/reload`, it reads `/_antseed/peers`, builds a
route map from `providerServiceApiProtocols`, and registers each
service/peer pair as a pi model. On each request, it sends
`x-antseed-pin-peer: <peerId>`, chooses the correct pi-ai provider for that
service protocol, and uses the correct base URL shape:

- `anthropic-messages` → proxy root (`http://localhost:8377`) because pi appends `/v1/messages`.
- `openai-responses` / `openai-chat-completions` → OpenAI base (`http://localhost:8377/v1`).

AntSeed still handles the selected peer connection, payment channels, provider
selection inside that peer, protocol adaptation, and metering on its side.
