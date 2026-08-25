'''tor-relay -- HTTP relay sending every request out through Tor.

Every request gets a fresh SOCKS credential (random username); a distinct
username:password on Tor's SOCKS port is a distinct circuit, i.e. a DISTINCT
EXIT IP -- so each served request leaves from a new IP and no single exit
ever accumulates call frequency on the target.

Tor is supervised BY THE APP (not start.sh): a background thread launches the
tor binary, waits for SOCKS readiness, restarts it if it dies, and keeps a
ring buffer of its output. This survives on Render's Docker runtime, where
background processes started in start.sh can be reaped when PID 1 is the
shell -- and gives us /diag to see tor's state from outside.

Speaks the exact /proxy?url=<encoded-target> interface glm2api's egress pool
already uses (X-Proxy-Key auth), so relay URLs drop straight into the engine
dashboard's Egress tab with zero engine changes.

Endpoints:
  GET  /health          -> current exit IP + latency (keep-alive ping target)
  GET  /diag            -> tor process state + last tor output lines (BASIC auth)
  GET/POST /proxy?url=  -> forward the request through a fresh Tor circuit

Env:
  PORT        listen port (injected by Render; default 7860)
  PROXY_KEY   optional shared secret; the engine sends it as X-Proxy-Key
  TOR_SOCKS   tor SOCKS endpoint (default 127.0.0.1:9050)
  TOR_BIN     tor binary path (default /usr/bin/tor)
  ALLOW_HOSTS comma-separated host allowlist (default chat.z.ai,api.ipify.org)
  DIAG_KEY    secret for /diag (default: PROXY_KEY or 'diag')
'''
from __future__ import annotations

import os
import shutil
import subprocess
import threading
import time
import uuid
from collections import deque
from urllib.parse import urlparse

from curl_cffi.requests import AsyncSession
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, PlainTextResponse, StreamingResponse

PROXY_KEY = os.environ.get('PROXY_KEY', '').strip()
TOR_SOCKS = os.environ.get('TOR_SOCKS', '127.0.0.1:9050').strip()
TOR_BIN = os.environ.get('TOR_BIN', '/usr/bin/tor')
ALLOW_HOSTS = {h.strip().lower() for h in
               os.environ.get('ALLOW_HOSTS', 'chat.z.ai,api.ipify.org').split(',')
               if h.strip()}
DIAG_KEY = os.environ.get('DIAG_KEY', '').strip() or PROXY_KEY or 'diag'
MAX_CIRCUIT_RETRIES = 3
_DROP_HEADERS = {'host', 'x-proxy-key', 'connection', 'keep-alive',
                 'transfer-encoding', 'te', 'trailer', 'upgrade',
                 'proxy-authorization', 'proxy-connection', 'content-length'}

app = FastAPI(title='tor-relay', docs_url=None, redoc_url=None)


# --------------------------------------------------------------------------- #
# Tor supervisor — launch, wait for SOCKS, restart on death, keep last output
# --------------------------------------------------------------------------- #
class TorSupervisor:
    def __init__(self) -> None:
        self.proc: subprocess.Popen | None = None
        self.log: deque[str] = deque(maxlen=60)
        self.state = 'stopped'
        self.started_at: float | None = None
        self.restart_count = 0
        self._lock = threading.Lock()

    def _log(self, line: str) -> None:
        self.log.append(line)
        print('[tor]', line, flush=True)  # also visible in platform logs

    def _socks_host_port(self) -> tuple[str, int]:
        host, _, port = TOR_SOCKS.rpartition(':')
        return (host or '127.0.0.1'), int(port or 9050)

    def _socks_ready(self) -> bool:
        import socket
        host, port = self._socks_host_port()
        try:
            with socket.create_connection((host, port), timeout=2):
                return True
        except OSError:
            return False

    def _write_torrc(self) -> str:
        host, port = self._socks_host_port()
        data_dir = os.environ.get('TOR_DATA', '/tmp/tor-data')
        os.makedirs(data_dir, exist_ok=True)
        path = os.path.join(data_dir, 'torrc')
        with open(path, 'w') as f:
            f.write(f'SocksPort {host}:{port}\n'
                    f'DataDirectory {data_dir}\n'
                    'Log notice stdout\n'
                    'SafeLogging 1\n')
        return path

    def _spawn(self) -> None:
        torrc = self._write_torrc()
        self.proc = subprocess.Popen(
            [TOR_BIN, '-f', torrc],
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, bufsize=1)
        threading.Thread(target=self._pump, daemon=True).start()

    def _pump(self) -> None:
        assert self.proc is not None and self.proc.stdout is not None
        for line in self.proc.stdout:
            self.log.append(line.rstrip())
        # stdout closed -> tor exited
        rc = self.proc.wait()
        self.state = f'exited (rc={rc})'
        self._log(f'tor exited rc={rc} -- restarting in 5s')
        time.sleep(5)
        self.start()

    def start(self) -> None:
        with self._lock:
            if not shutil.which(TOR_BIN) and not os.path.exists(TOR_BIN):
                self.state = f'tor binary not found at {TOR_BIN}'
                self._log(self.state)
                return
            self.state = 'starting'
            self.started_at = time.time()
            self._spawn()
        threading.Thread(target=self._await_ready, daemon=True).start()

    def _await_ready(self) -> None:
        deadline = time.time() + 90
        while time.time() < deadline:
            if self.proc is not None and self.proc.poll() is not None:
                return  # exited; _pump handles the restart
            if self._socks_ready():
                self.state = 'ready'
                self._log('tor SOCKS is up')
                return
            time.sleep(1)
        self.state = 'timeout waiting for SOCKS'
        self._log(self.state)

    def status(self) -> dict:
        return {'state': self.state, 'binary': TOR_BIN,
                'pid': self.proc.pid if self.proc else None,
                'uptime_s': round(time.time() - self.started_at) if self.started_at else None,
                'restarts': self.restart_count, 'socks': TOR_SOCKS,
                'recent_log': list(self.log)[-25:]}


supervisor = TorSupervisor()
supervisor.start()


# --------------------------------------------------------------------------- #
# Request path
# --------------------------------------------------------------------------- #
def _circuit_session() -> AsyncSession:
    '''One session per request: a random SOCKS username isolates its own
    Tor circuit, i.e. its own exit IP.'''
    return AsyncSession(impersonate='chrome',
                        proxy='socks5h://%s:x@%s' % (uuid.uuid4().hex, TOR_SOCKS))


async def _close(session, resp=None):
    for obj in (resp, session):
        if obj is None:
            continue
        try:
            closer = getattr(obj, 'aclose', None) or getattr(obj, 'close', None)
            if closer is not None:
                res = closer()
                if res is not None and hasattr(res, '__await__'):
                    await res
        except Exception:
            pass


def _allowed(url: str) -> bool:
    try:
        return (urlparse(url).hostname or '').lower() in ALLOW_HOSTS
    except ValueError:
        return False


def _forward_headers(req: Request) -> dict:
    return {k: v for k, v in req.headers.items() if k.lower() not in _DROP_HEADERS}


@app.get('/health')
async def health():
    '''Exit IP probe -- doubles as the keep-alive ping for free tiers.'''
    t0 = time.monotonic()
    session = _circuit_session()
    try:
        r = await session.get('https://api.ipify.org?format=json', timeout=60)
        ct = r.headers.get('content-type', '')
        ip = r.json().get('ip') if 'json' in ct else r.text.strip()
        return {'ok': True, 'exit_ip': ip, 'tor_state': supervisor.state,
                'ms': int((time.monotonic() - t0) * 1000), 'tor_socks': TOR_SOCKS}
    except Exception as e:  # noqa: BLE001 -- tor down / circuit failed
        return JSONResponse({'ok': False, 'tor_state': supervisor.state,
                             'error': str(e) or type(e).__name__,
                             'tor_socks': TOR_SOCKS}, status_code=503)
    finally:
        await _close(session)


@app.get('/diag')
async def diag(request: Request):
    '''Tor supervisor state + recent tor output. Protected by DIAG_KEY.'''
    key = request.query_params.get('key', '')
    if key != DIAG_KEY:
        return PlainTextResponse('forbidden', status_code=403)
    return supervisor.status()


@app.api_route('/proxy', methods=['GET', 'POST'])
async def proxy(request: Request):
    url = request.query_params.get('url', '')
    if PROXY_KEY and request.headers.get('x-proxy-key') != PROXY_KEY:
        return JSONResponse({'detail': 'bad or missing proxy key'}, status_code=401)
    if not _allowed(url):
        return JSONResponse({'detail': 'host not allowed'}, status_code=403)

    body = await request.body()
    headers = _forward_headers(request)
    last_error = None

    for attempt in range(MAX_CIRCUIT_RETRIES):
        session = _circuit_session()
        try:
            resp = await session.request(request.method, url, headers=headers,
                                         data=body or None, stream=True,
                                         timeout=300)
        except Exception as e:  # noqa: BLE001 -- dead circuit; try a new one
            last_error = e
            await _close(session)
            continue
        ct = (resp.headers.get('content-type') or '').lower()
        if 'text/html' in ct and attempt < MAX_CIRCUIT_RETRIES - 1:
            # HTML answer = this exit looks pre-blocked -- fresh circuit.
            await _close(session, resp)
            continue
        # content-type MUST pass through: the engine detects z.ai's HTML
        # block pages by it, and SSE needs its text/event-stream type intact.
        out = {'content-type': resp.headers.get('content-type',
                                                'application/octet-stream')}

        async def stream():
            try:
                async for chunk in resp.aiter_content():
                    yield chunk
            finally:
                await _close(session, resp)

        return StreamingResponse(stream(), status_code=resp.status_code,
                                 headers=out)

    return JSONResponse({'detail': 'tor circuits failed: %s' % last_error},
                        status_code=502)
