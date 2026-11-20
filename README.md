English | [中文](README.zh.md)

# AgentFacade

One facade in front of eleven model platforms. Callers see a single model list;
platforms, accounts, dialects, cooldowns and quotas stay behind it. OpenAI and
Anthropic clients share one port.

## What you get

- **One URL for eleven platforms.** MiniMax Code, ZCode, Qoder (global and
  China), WorkBuddy (China and international), TokenRhythm, SenseNova,
  书生·端砚, 七牛云 and 讯飞星火. The root route carries a published model list;
  each platform also has its own route with its own model ids.
- **Both dialects, streaming and not.** OpenAI `/v1/chat/completions` and
  Anthropic `/v1/messages` are accepted on the root route and on every platform
  route. Tool calls and the thinking channel are converted in both directions.
- **Several accounts per platform.** A weight decides which account is tried
  first. On a fallback platform, another account takes over when the current
  one fails, runs out of quota or enters cooldown; the response says when the
  unavailable account will recover.
- **Simulated clients.** For platforms that only answer their own desktop
  client, our requests align with that client's request fingerprint so the
  platform answers us. This is not authentication bypass: the account still
  needs a legitimate login and valid credentials.
- **One published model list.** A published model name can point to several
  upstreams. The panel shows which one is serving and how traffic is split.
  Upstreams that cannot serve leave the list with a reason, not a 404.
- **A panel for the numbers.** Quota, credits and balance per account, usage
  per request, accounts, published models, and the login flows.
- **Daily credits, claimed for you.** Platforms that give out credits for
  showing up are checked in once at startup and then hourly.

## Quick start

With Docker (the panel is built into the image):

```bash
docker run -d --name agentfacade \
  -p 6450:6450 \
  -v "$PWD/data:/data" \
  shaylulimo/agentfacade:latest
```

With node:

```bash
mise install      # tool versions this project expects
pnpm install
mise run serve    # node router-proxy.ts, on http://localhost:6450
```

The gateway answers on `http://<host>:6450`; the panel is at
`http://<host>:6450/admin/`. Sign in with the token in `<FACADE_DATA_DIR>/admin-token`,
written on first start. No account is enabled initially — add one in the panel's
上游 tab before sending requests.

Everything the service keeps lives in `FACADE_DATA_DIR`: `~/.agentfacade` by
default (or `/data` in Docker), with the database file `agentfacade.db`. Keep
this directory across restarts: it holds the sessions. All environment
variables use the `FACADE_*` prefix.

## Point a client at it

The **root route** puts the platform in the model id:

```text
base url : http://<host>:6450/v1
model    : qoder-cn/glm-5.3
```

A **platform route** uses the platform's own model ids, and is unaffected by
what you publish on the root route:

```text
base url : http://<host>:6450/qoder-cn/v1
model    : glm-5.3
```

SDK base urls, one line each:

```text
OpenAI    : base_url = "http://<host>:6450/v1"
Anthropic : base_url = "http://<host>:6450"   # the SDK appends /v1/messages
```

The key goes in `Authorization: Bearer <key>` for OpenAI and `x-api-key: <key>`
for Anthropic. A fresh installation accepts any key unless the deployment
requires one.

```bash
# OpenAI dialect
curl http://localhost:6450/v1/chat/completions \
  -H "Authorization: Bearer <key>" -H "Content-Type: application/json" \
  -d '{"model":"qoder-cn/glm-5.3","messages":[{"role":"user","content":"hi"}]}'

# Anthropic dialect
curl http://localhost:6450/v1/messages \
  -H "x-api-key: <key>" -H "Content-Type: application/json" \
  -d '{"model":"qoder-cn/glm-5.3","max_tokens":1024,"messages":[{"role":"user","content":"hi"}]}'
```

`GET /v1/models` returns the models published on the root route;
`GET /{platform}/v1/models` returns that platform's own catalogue. The default
**shape is OpenAI**. `?dialect=anthropic` switches to the Anthropic shape,
`?dialect=openai` is explicit default, and an unknown value is a 400. Without
the query, request headers decide: `anthropic-version`, `anthropic-beta`, or an
`x-api-key` without `authorization` selects the Anthropic shape; everyone else
gets OpenAI.

## Plugins: keep client model lists in sync

Repo: https://github.com/yxlimo/agentfacade-extensions

Install:

```text
pi                  pi install npm:pi-agentfacade
OpenCode (2.x)      opencode.jsonc 的 plugins 里加 "opencode-agentfacade@latest"
DeepSeek Harness    dsh plugin --profile <profile> add dsh-agentfacade
```

What a plugin does: it fetches `GET {gateway}/v1/models` once at startup and
then every 5 minutes. It re-registers the models and writes one log line only
when ids were added or removed. If the fetch fails, it keeps the previous list
rather than registering an empty one.

It does **not** write the agent's own configuration files (`models.json`,
`opencode.jsonc`, `cordis.patch.yml` are yours); registration goes through each
agent's runtime API. The provider name is always `agentfacade`, separate from
any provider you already use.

Connection settings:

- Default gateway: `http://127.0.0.1:6450`.
- `/agentfacade connect <host[:port]>` writes `~/.config/agentfacade/config.json`;
  you can edit that JSON directly instead.
- Environment variables take precedence over the file: `FACADE_GATEWAY`, or
  `PI_FACADE_GATEWAY` / `OPENCODE_FACADE_GATEWAY` / `DSH_FACADE_GATEWAY`.
- When the gateway requires a key, use `FACADE_API_KEY` or the matching
  `*_FACADE_API_KEY`, or `~/.config/agentfacade/auth.json`. The panel and CLI
  write the latter without echoing the key.
- In pi, `/agentfacade` shows the current gateway and how many models are
  registered; `/agentfacade probe` is an optional liveness check.

**How the two halves work together:**

```text
Gateway: platforms, accounts, switching, cooldowns, quotas, request fingerprints — all behind the facade
            ↓  one model list (/v1/models)
Plugin:  installs that list into pi / OpenCode / DeepSeek Harness
```

Add a model in the panel or change the primary route and the clients need no
configuration change — they follow within 5 minutes. Upstream credentials
never leave the gateway; clients only get the gateway's own key. The boundary
is strict: the gateway knows nothing about any client, the plugin knows nothing
about any upstream — the model list is all they share.

## Upgrade

Older releases used the `BUDDY_*` environment prefix and the database file
`buddy.db`. Rename the database before starting the new version (there is no
fallback):

```bash
mv /data/buddy.db /data/agentfacade.db
```

Then change `BUDDY_DATA_DIR` to `FACADE_DATA_DIR` and rename `~/.buddy-proxy`
to `~/.agentfacade` outside Docker.

## Docs

- [`docs/reference/`](docs/reference/) — architecture notes, conventions,
  deployment and review process.
- [`CONVENTIONS.md`](CONVENTIONS.md) — coding conventions for this repository.
