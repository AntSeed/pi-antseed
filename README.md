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

### 1. Install AntSeed

```bash
npm i -g antseed
antseed --version
```

Identity / state lives in `~/.antseed/`.

### 2. Fund the buyer wallet

`antseed buyer status` shows your wallet address. Either:

- **Deposits** (pay-as-you-go): send USDC on Base to your wallet, then
  `antseed buyer deposit 5` (deposits 5 USDC into the on-chain deposits
  contract).
- **Subscription** (flat rate): `antseed buyer subscribe join <tierId>`.

Verify with `antseed buyer balance` and `antseed buyer subscribe status`.

### 3. Start the buyer proxy

```bash
antseed buyer start
```

This opens the OpenAI-compatible proxy on the port from `~/.antseed/config.json`
(`buyer.proxyPort`, default `8377`).

Sanity-check it:

```bash
curl -s http://localhost:8377/v1/models | jq
```

> If you get an empty list, the buyer is up but isn't connected to any seller
> yet — keep going.

### 4. Find a peer (seller) to talk to

Browse the network for sellers and the services they offer:

```bash
antseed network browse --services
antseed network browse --service claude-sonnet-4-5-20250929 --sort price
```

Pick a peer ID (40-char hex, e.g. `4668854ba3e8b094e6f48fbeb59cec1cfde162f2`)
and inspect it:

```bash
antseed network peer <peerId>
```

### 5. Connect to that peer

Two options:

**a) Pin a single peer for the session** (what was done on this machine):

```bash
antseed buyer connection set --peer <peerId>
```

That's it. `curl http://localhost:8377/v1/models` should now list the peer's
services, and pi can route requests through them.

To unpin later:

```bash
antseed buyer connection clear
```

**b) Use a router plugin** — pass `--router <name>` (or `--instance <id>`) to
`antseed buyer start` to let a configured router pick peers automatically. See
`antseed buyer start --help`.

### 6. Use it in pi

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
  `antseed buyer connection set --peer <id>` or configure a router.
- **`Connection state: idle` in `antseed buyer status`** — run
  `antseed buyer start` and keep it running.
- **Insufficient deposits** — `antseed buyer balance` should be > 0, or you
  need an active subscription.

---

## How it works

`extensions/antseed.ts` calls `pi.registerProvider("antseed", { ... })` with
`api: "openai-completions"` and `authHeader: true`, pointing at the local
AntSeed buyer proxy. Pi then treats AntSeed like any other OpenAI-compatible
provider; AntSeed handles peer selection, payment channels, and metering on its
side.
