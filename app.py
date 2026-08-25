'''tor-relay -- HTTP relay that sends every request out through Tor.

Every request gets a fresh SOCKS credential (random username); a distinct
username:password on Tor's SOCKS port is a distinct circuit, i.e. a DISTINCT
EXIT IP -- so each served request leaves from a new IP and no single exit
ever accumulates call frequency on the target.

Speaks the exact /proxy?url=<encoded-target> interface glm2api's egress pool
already uses (X-Proxy-Key auth), so relay URLs drop straight into the engine
dashboard's Egress tab with zero engine changes.

Endpoints:
  GET  /health          -> current exit IP + latency (keep-alive ping target)
  GET/POST /proxy?url=  -> forward the request through a fresh Tor circuit

Env:
  PORT        listen port (injected by Render/PandaStack; default 7860)
  PROXY_KEY   optional shared secret; the engine sends it as X-Proxy-Key
  TOR_SOCKS   tor SOCKS endpoint (default 127.0.0.1:9050; Tor Browser = 9150)
  ALLOW_HOSTS comma-separated host allowlist (default chat.z.ai,api.ipify.org)
'''
from __future__ import annotations

import os
import time
import uuid
from urllib.parse import urlparse

from curl_cffi.requests import AsyncSession
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse

PROXY_KEY = os.environ.get('PROXY_KEY', '').strip()
TOR_SOCKS = os.environ.get('TOR_SOCKS', '127.0.0.1:9050').strip()
ALLOW_HOSTS = {h.strip().lower() for h in
               os.environ.get('ALLOW_HOSTS', 'chat.z.ai,api.ipify.org').split(',')
               if h.strip()}
# Shared Tor exits are sometimes pre-blocked by the target (HTML block page).
# A fresh circuit = a new exit IP, so retry on an HTML answer before giving up.
MAX_CIRCUIT_RETRIES = 3
_DROP_HEADERS = {'host', 'x-proxy-key', 'connection', 'keep-alive',
                 'transfer-encoding', 'te', 'trailer', 'upgrade',
                 'proxy-authorization', 'proxy-connection', 'content-length'}

app = FastAPI(title='tor-relay', docs_url=None, redoc_url=None)


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
        return {'ok': True, 'exit_ip': ip,
                'ms': int((time.monotonic() - t0) * 1000), 'tor_socks': TOR_SOCKS}
    except Exception as e:  # noqa: BLE001 -- tor down / circuit failed
        return JSONResponse({'ok': False, 'error': str(e) or type(e).__name__,
                             'tor_socks': TOR_SOCKS}, status_code=503)
    finally:
        await _close(session)


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
