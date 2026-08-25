# tor-relay

HTTP relay that sends every request out through Tor with a **fresh exit IP per request**. Speaks the exact `/proxy?url=` interface glm2api's egress pool already understands -- paste the deployment URL into the engine dashboard's Egress tab and it becomes one more rotating egress candidate. Zero engine changes.

## How the rotation works

A distinct `username:password` on Tor's SOCKS port gets its own circuit (own exit IP). The relay generates a random username per request, so every request leaves from a new IP and no single exit ever accumulates call frequency on the target. If an exit answers with an HTML block page, the relay silently retries on a fresh circuit (up to 3x) before passing the page back.

## Deploy

**Render (verified: AUP has no Tor/proxy clause):**
1. Push this repo to GitHub, then Render -> New -> Blueprint (picks up `render.yaml`), or New -> Web Service -> Docker.
2. Set the `PROXY_KEY` env var to a secret (optional but recommended).
3. Free tier sleeps after ~15 min idle -- keep it awake with a free cron (cron-job.org) hitting `/health` every 10 min.

**PandaStack:** Docker deploy, same image, same env vars (same pattern as the mint-relays).

**NOT deployable:** Railway (AUP bans operating proxies/anonymization services), Vercel / Cloudflare Workers (serverless, no daemon processes), Hugging Face Spaces (content policy names TOR explicitly).

## Wire into glm2api

Dashboard -> Egress tab -> relay textarea, one URL per line:

    https://your-tor-relay.onrender.com?key=SECRET

Then "Test all" -- each relay probe shows its current exit IP. Rotation, cooldowns, and Chrome-TLS all come from the existing pool logic.

## Local test (Tor Browser running, SOCKS on 9150)

    TOR_SOCKS=127.0.0.1:9150 python -m uvicorn app:app --port 8899
    curl 'http://127.0.0.1:8899/proxy?url=https%3A%2F%2Fapi.ipify.org'   # run twice -- two different IPs

## Env

| var | default | meaning |
|---|---|---|
| `PORT` | `7860` | listen port (injected by the platform) |
| `PROXY_KEY` | *(empty)* | shared secret; engine sends it as `X-Proxy-Key` |
| `TOR_SOCKS` | `127.0.0.1:9050` | tor SOCKS endpoint (Tor Browser: `9150`) |
| `ALLOW_HOSTS` | `chat.z.ai,api.ipify.org` | hosts the relay will forward to |
