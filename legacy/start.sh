#!/usr/bin/env bash
# uvicorn only -- tor is supervised BY THE APP (app.py TorSupervisor):
# launch, SOCKS-readiness wait, crash auto-restart, /diag state. This keeps
# tor alive on Render's Docker runtime regardless of how PID 1 reaps
# background processes started from a shell script.
set -e
exec uvicorn app:app --host 0.0.0.0 --port "${PORT:-7860}" --workers 1
