# tor-relay — Next.js dashboard

HTTP relay that sends every request out through **Tor with a fresh exit IP per request**, with a beautiful live dashboard that shows exactly which exit IP each request was routed through.

This branch (`nextjs-dashboard`) is the Next.js 16 + Tailwind 4 + shadcn/ui rewrite of the original python `app.py` (preserved in [`legacy/`](./legacy) for reference). It mirrors the look & feel of [vertex-proxy-zai](https://github.com/Sexlovr/vertex-proxy-zai) and extends it with:

- **Exit IP column** — every log entry shows the Tor exit IP that the request was routed out through to the target URL (the user-requested feature).
- **In-app password management** — set / change / clear the proxy password from the dashboard's Settings tab. Stored as a bcrypt hash in SQLite (no env var editing required).
- **Dashboard lock** — optionally require the password to view logs / settings / tor.
- **Expanded provider allowlist** — Vertex AI, Gemini API, OpenAI, Anthropic, Z.ai, ChatGLM, ModelArk (Volcengine Ark / BytePlus), ipify, plus test hosts (original python relay only allowed `chat.z.ai` + `api.ipify.org`).
- **Tor supervisor in Node** — spawns tor, waits for SOCKS readiness, auto-restarts on death, exposes state via `/api/tor`. Falls back to mock mode when the tor binary isn't installed (so the dashboard is still demonstrable in sandboxes).

## Architecture

```
src/
├── app/
│   ├── layout.tsx                       # dark theme + Sonner toaster
│   ├── page.tsx                         # 4-tab dashboard (logs/providers/tor/settings) + login overlay
│   ├── globals.css
│   └── api/
│       ├── health/route.ts              # GET /api/health
│       ├── auth/route.ts                # POST /api/auth (verify password for locked dashboard)
│       ├── logs/route.ts                # GET /api/logs, DELETE /api/logs (auth-gated when locked)
│       ├── logs/[id]/route.ts           # DELETE /api/logs/{id}
│       ├── proxy/route.ts               # MAIN: relay through Tor + capture exit IP
│       ├── providers/route.ts           # GET /api/providers
│       ├── settings/route.ts            # GET /api/settings (public status, no secrets)
│       ├── settings/password/route.ts   # POST set/change password
│       ├── settings/clear/route.ts      # POST clear stored password
│       ├── settings/lock/route.ts       # POST toggle dashboard lock
│       ├── tor/route.ts                 # GET /api/tor (supervisor status)
│       └── tor/test/route.ts            # POST /api/tor/test (probe fresh circuit)
├── components/ui/                        # shadcn/ui component set
├── hooks/                                # use-mobile, use-toast
└── lib/
    ├── auth.ts                          # requireAuthIfLocked helper
    ├── db.ts                            # Prisma client
    ├── logs.ts                          # in-memory log store (exitIp, viaTor, provider, bytes)
    ├── providers.ts                     # Vertex/Gemini/OpenAI/Anthropic/Z.ai/ChatGLM/ModelArk allowlist
    ├── settings.ts                      # bcrypt password storage + lock state
    ├── tor.ts                           # TorSupervisor + per-request SOCKS agent factory
    └── utils.ts                         # cn helper
```

## How the exit IP capture works

For every proxied request:

1. `supervisor.newAgent()` allocates a fresh `SocksProxyAgent` with a random SOCKS username (`socks5h://tor-relay-<uuid>:<uuid>@host:port`). On Tor, a distinct username:password is a distinct circuit = a distinct exit IP.
2. The proxy route probes that exit IP by hitting `api.ipify.org` through the **same** SOCKS session (so the captured IP is the one that will be used for the real request).
3. The captured IP is stored in the log entry as `exitIp` along with `viaTor` (true/false) and `provider`.
4. The dashboard shows the exit IP prominently in violet with a `via tor` or `direct` badge.

**Important:** uses `node-fetch` v3 (not native `fetch`) because native `fetch` in Node silently ignores the `agent` option — SOCKS routing would be a no-op.

## How the in-app password works

- First visit: dashboard shows an "open relay" banner. Settings tab → "set initial password".
- The password is hashed with bcrypt (cost 10) and stored in the `Setting` table (`key=proxy_key_hash`).
- The proxy route (`/api/proxy`) checks the DB hash first, then falls back to the `PROXY_KEY` env var, then defaults to open relay.
- The dashboard lock toggle (`/api/settings/lock`) gates `/api/logs`, `/api/settings`, `/api/tor` behind `x-tor-relay-auth` header (sent by the dashboard after login). The proxy endpoint is always password-protected (when a password is set).

## Quick start

```bash
# Install deps
bun install

# Push Prisma schema to SQLite (creates db/custom.db)
bun run db:push

# Start dev server (port 3000)
bun run dev

# Open the dashboard
open http://localhost:3000
```

### First-run setup

1. Open the dashboard → Settings tab.
2. "Set initial password" — pick a password (≥ 4 chars), confirm, submit.
3. The relay is now password-protected. Use `?key=<password>` or `X-Proxy-Key: <password>` on `/api/proxy`.
4. (Optional) Toggle "lock dashboard" to require the password for viewing the dashboard too.

### With a real Tor binary

```bash
apt-get install tor
TOR_BIN=/usr/bin/tor bun run dev
```

The supervisor will boot tor, wait for SOCKS readiness, and every proxied request will actually leave through a different Tor exit IP. The `legacy/Dockerfile` already installs tor — same pattern applies for Docker deploys.

### Mock mode (no tor installed)

If `tor` isn't on the PATH, the supervisor automatically switches to mock mode: the proxy goes direct, and exit IPs are picked from a rotating pool of plausible Tor exit IPs. This makes the dashboard fully demonstrable in sandboxes / dev machines without tor.

## API reference

| Method | Path | Description |
|---|---|---|
| GET | `/api/health` | Worker + tor state |
| GET | `/api/settings` | Public auth status (no secrets) |
| POST | `/api/settings/password` | Set / change password (body: `{current?, next}`) |
| POST | `/api/settings/clear` | Clear stored password (body: `{current}`) |
| POST | `/api/settings/lock` | Toggle dashboard lock (body: `{locked, current}`) |
| POST | `/api/auth` | Verify password for locked dashboard (body: `{password}`) |
| GET | `/api/logs` | All log entries (auth-gated when locked) |
| DELETE | `/api/logs` | Clear all logs |
| DELETE | `/api/logs/{id}` | Delete one log entry |
| ANY | `/api/proxy?url=<encoded>` | Relay through Tor + capture exit IP |
| GET | `/api/providers` | Allowlist grouped by provider |
| GET | `/api/tor` | Tor supervisor status |
| POST | `/api/tor/test` | Spin up fresh circuit + probe exit IP |

## Env vars

| var | default | meaning |
|---|---|---|
| `PORT` | `3000` | listen port |
| `PROXY_KEY` | *(empty)* | fallback proxy password (DB password takes precedence) |
| `TOR_BIN` | `tor` | path to tor binary |
| `TOR_SOCKS` | `127.0.0.1:9050` | tor SOCKS endpoint |
| `TOR_DATA` | `/tmp/tor-relay-data` | tor data directory |
| `TOR_MOCK` | `0` | force mock mode |
| `TOR_DISABLED` | `0` | disable tor entirely |
| `DATABASE_URL` | `file:./db/custom.db` | SQLite path |

## Legacy (python original)

The original python FastAPI app is preserved in [`legacy/`](./legacy) for reference. It uses the same `/proxy?url=` contract but lacks the dashboard, in-app password management, and expanded provider allowlist.

## Deploy

This Next.js app deploys like any other Next.js 16 app (Vercel / Render / self-hosted). The original deploy notes about Render apply (it allows tor daemons; Railway does not). The `legacy/Dockerfile` shows the tor + python pattern — for the Next.js version you'd want a Dockerfile that installs both tor and Node.
