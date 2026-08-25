#!/usr/bin/env bash
# tor daemon (SOCKS 9050) + uvicorn. Deploys OFF HF on purpose -- HF's
# content policy forbids Tor; Render's and PandaStack's do not.
set -e
mkdir -p /var/lib/tor
tor -f /app/torrc &
sleep 3   # head start for first circuits; the app builds fresh ones on demand
exec uvicorn app:app --host 0.0.0.0 --port "${PORT:-7860}" --workers 1
