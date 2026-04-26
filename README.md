# pi-antseed

Use [AntSeed](https://antseed.ai) as a model provider in [pi](https://shittycodingagent.ai).

AntSeed runs a **local buyer proxy** (default `http://localhost:8377/v1`) that
speaks the OpenAI Chat Completions API. This package registers that proxy as a
pi provider called `antseed`, so you can switch to AntSeed-routed models with
`/model antseed/<id>`.

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

Restart pi (or `/reload`), then pick an open-source model:

```
/model antseed/minimax-m2.7
```

---

## Prerequisites — getting AntSeed wired up

This is the path to a working `/v1/models` listing on `http://localhost:8377`,
which is what this extension needs.

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

Inspect a specific peer:

```bash
antseed peer <peerId>
```

### 6. Connect to that peer

While `antseed buyer start` is running, pin a peer for the session:

```bash
antseed buyer connection set --peer <40-char-hex-peer-id>
```

Or pin a specific service (rewrites the `model` field on every request):

```bash
antseed buyer connection set --service <service-id>
```

State lives in `~/.antseed/buyer.state.json` and is picked up by the running
proxy via file-watching. Inspect or clear:

```bash
antseed buyer connection get
antseed buyer connection clear            # clear all
antseed buyer connection clear --peer     # clear only the peer pin
```

Alternatively, start the proxy with a non-default router so peer selection is
automatic:

```bash
antseed buyer start --router <name>
```

After pinning, `curl http://localhost:8377/v1/models` should now list the
peer's services.

### 7. Use it in pi

```
/model antseed/minimax-m2.7
```

MiniMax M2.7 is an open-weights model — preferred default for this package.
If `/v1/models` returns IDs not in the built-in list, set `ANTSEED_MODELS`:

```bash
ANTSEED_MODELS="minimax-m2.7,minimax-m2.7-highspeed" pi
```

---

## Configuration

| Env var            | Default                           | Purpose                                                   |
| ------------------ | --------------------------------- | --------------------------------------------------------- |
| `ANTSEED_BASE_URL` | `http://localhost:8377/v1`        | Override the buyer proxy URL.                             |
| `ANTSEED_API_KEY`  | _(unset)_                         | Only needed if you front the proxy with auth.            |
| `ANTSEED_MODELS`   | _(built-in list)_                 | Comma-separated model IDs to register, overrides default. |

---

## Troubleshooting

- **`502 Bad Gateway` on `/v1/messages`** — expected; the proxy speaks Chat
  Completions, not the Anthropic API. pi uses `openai-completions` here.
- **Empty `/v1/models`** — no peer is connected. Pin one with
  `antseed buyer connection set --peer <id>`, or start the proxy with
  `--router <name>`.
- **`Connection state: idle` in `antseed buyer status`** — run
  `antseed buyer start` and keep it running.
- **Insufficient deposits** — `antseed buyer balance` should be > 0; top up
  via `antseed payments`.
- **Identity errors** — make sure `ANTSEED_IDENTITY_HEX` is exported in the
  shell that runs `antseed buyer start`.

---

## How it works

`extensions/antseed.ts` calls `pi.registerProvider("antseed", { ... })` with
`api: "openai-completions"` and `authHeader: true`, pointing at the local
AntSeed buyer proxy. Pi then treats AntSeed like any other OpenAI-compatible
provider; AntSeed handles peer selection, payment channels, and metering on its
side.
