import { NextRequest, NextResponse } from "next/server";
import nodeFetch from "node-fetch";
import {
  HOP_HEADERS,
  pushLog,
} from "@/lib/logs";
import { isAllowed, providerForHost } from "@/lib/providers";
import { ensureTorBooted, supervisor } from "@/lib/tor";
import { verifyPassword, isOpenRelay } from "@/lib/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function clientIP(req: NextRequest): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  return req.headers.get("x-real-ip") || "unknown";
}

/**
 * Probe the exit IP that this SOCKS agent will exit through.
 *
 * Hits api.ipify.org through the SAME circuit (same random SOCKS username)
 * so the captured IP is the one that will be used for the real upstream
 * request. Uses node-fetch v3 — native Node fetch silently ignores the
 * `agent` option, which would make SOCKS routing a no-op.
 */
async function probeExitIp(
  agent: unknown,
  signal: AbortSignal,
): Promise<{ exitIp: string; ok: boolean; error: string | null }> {
  try {
    const r = await nodeFetch("https://api.ipify.org?format=json", {
      method: "GET",
      // @ts-expect-error node-fetch accepts http.Agent via `agent`
      agent,
      signal,
      headers: { "user-agent": "tor-relay/probe", connection: "close" },
    });
    const text = await r.text();
    try {
      const j = JSON.parse(text) as { ip?: string };
      return { exitIp: j.ip || text.trim(), ok: true, error: null };
    } catch {
      return { exitIp: text.trim(), ok: true, error: null };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { exitIp: "unknown", ok: false, error: msg };
  }
}

/**
 * tor-relay proxy — streaming, allowlisted, **Tor-routed with a fresh exit IP per request**.
 *
 * Contract (compatible with the original python tor-relay on master):
 *   ANY  /api/proxy?url=<enc>   → relay to (allowlisted) target via Tor
 *   Auth: DB-stored password > PROXY_KEY env > open relay
 *         → ?key= or X-Proxy-Key header
 *
 * Every request gets a fresh SOCKS5h agent with a random username:password
 * — Tor treats a distinct SOCKS user as a distinct circuit, i.e. a distinct
 * exit IP. No mock mode, no direct routing, no fallback. If tor isn't
 * ready, the request fails with 502.
 *
 * Dashboard contract:
 *   Every request gets a log entry with `exitIp` = the Tor exit IP that
 *   was used to forward the request. The dashboard's "Exit IP" column
 *   shows this — i.e. "which IP the request was routed out through to
 *   the URL".
 */
async function handler(req: NextRequest) {
  await ensureTorBooted();
  const startedAt = Date.now();
  const u = new URL(req.url);
  const ip = clientIP(req);
  const ua = req.headers.get("user-agent") || "";
  const referer = req.headers.get("referer") || "";

  // -- proxy auth (DB password > env var > open) --
  const open = await isOpenRelay();
  if (!open) {
    const provided =
      u.searchParams.get("key") ||
      req.headers.get("x-proxy-key") ||
      "";
    const ok = await verifyPassword(provided);
    if (!ok) {
      pushLog({
        method: req.method,
        path: u.pathname,
        target: u.searchParams.get("url"),
        ip,
        exitIp: "—",
        viaTor: false,
        provider: "auth",
        ua,
        referer,
        status: 401,
        durationMs: Date.now() - startedAt,
        bytes: null,
        error: "bad proxy key",
      });
      return new NextResponse("Unauthorized", { status: 401 });
    }
  }

  // -- target resolution --
  let target = u.searchParams.get("url");
  if (!target && u.pathname.startsWith("/api/proxy/")) {
    target = decodeURIComponent(
      u.pathname.slice("/api/proxy/".length).replace(/\+/g, "%20"),
    );
  }
  if (!target) {
    pushLog({
      method: req.method,
      path: u.pathname,
      target: null,
      ip,
      exitIp: "—",
      viaTor: false,
      provider: "—",
      ua,
      referer,
      status: 400,
      durationMs: Date.now() - startedAt,
      bytes: null,
      error: "missing target url",
    });
    return new NextResponse(
      "Missing target URL. Use /api/proxy?url=<encoded>.",
      { status: 400 },
    );
  }

  let targetURL: URL;
  try {
    targetURL = new URL(target);
  } catch {
    pushLog({
      method: req.method,
      path: u.pathname,
      target,
      ip,
      exitIp: "—",
      viaTor: false,
      provider: "—",
      ua,
      referer,
      status: 400,
      durationMs: Date.now() - startedAt,
      bytes: null,
      error: "invalid target url",
    });
    return new NextResponse("Invalid target URL", { status: 400 });
  }

  const provider = providerForHost(targetURL.hostname);
  if (!isAllowed(targetURL.hostname)) {
    pushLog({
      method: req.method,
      path: u.pathname,
      target,
      ip,
      exitIp: "—",
      viaTor: false,
      provider: provider?.id || "unknown",
      ua,
      referer,
      status: 403,
      durationMs: Date.now() - startedAt,
      bytes: null,
      error: `host ${targetURL.hostname} not allowed`,
    });
    return new NextResponse(`Host ${targetURL.hostname} not allowed`, {
      status: 403,
    });
  }

  // -- NEWNYM (fire-and-forget, never blocks the request) + fresh agent --
  // The random SOCKS credentials alone already force a fresh circuit per
  // request; NEWNYM is just extra insurance and MUST NOT add latency or
  // abort the real request. Rate-limited to 1/10s by Tor anyway.
  void supervisor.sendNewNym().catch(() => {});
  const { agent, circuit } = supervisor.newAgent();

  // -- probe exit IP on a SEPARATE controller so its timeout can never
  //    abort the real request (shared controller = the 'aborted' bug) --
  const probeController = new AbortController();
  setTimeout(() => probeController.abort(), 25_000);
  const probe = await probeExitIp(agent, probeController.signal).catch(
    () => ({ exitIp: "unknown", ok: false, error: "probe failed" }),
  );
  const exitIp = probe.exitIp;

  // Upstream lifetime is tied to the CLIENT connection (req.signal): as
  // long as the caller is still reading, the stream stays open — a long
  // thinking response can run minutes without a fixed timer killing it.
  // An idle-deadline (no bytes for 5min) only guards against a hung circuit;
  // any data resets it.
  const controller = new AbortController();
  let idleTimer: ReturnType<typeof setTimeout> | null = setTimeout(
    () => controller.abort(),
    300_000,
  );
  const bumpIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => controller.abort(), 300_000);
  };
  req.signal.addEventListener("abort", () => controller.abort());

  // -- forward headers (strip hop-by-hop) --
  const upstreamHeaders: Record<string, string> = {};
  req.headers.forEach((v, k) => {
    if (!HOP_HEADERS.has(k.toLowerCase())) upstreamHeaders[k] = v;
  });
  upstreamHeaders["connection"] = "close";

  // -- streaming fetch through the same SOCKS circuit (via node-fetch) --
  let upstream: nodeFetch.Response;
  try {
    const fetchOpts: nodeFetch.RequestInit = {
      method: req.method,
      headers: upstreamHeaders,
      // @ts-expect-error node-fetch honors `agent`
      agent,
      redirect: "manual",
      // @ts-expect-error signal is part of standard RequestInit
      signal: controller.signal,
    };
    if (!["GET", "HEAD"].includes(req.method)) {
      fetchOpts.body = Buffer.from(await req.arrayBuffer());
    }
    upstream = await nodeFetch(targetURL.toString(), fetchOpts);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (idleTimer) clearTimeout(idleTimer);
    pushLog({
      method: req.method,
      path: u.pathname,
      target,
      ip,
      exitIp,
      viaTor: true,
      provider: provider?.id || "—",
      ua,
      referer,
      status: 502,
      durationMs: Date.now() - startedAt,
      bytes: null,
      error: msg,
    });
    return NextResponse.json(
      { error: msg, circuit, exitIp },
      { status: 502 },
    );
  }

  // -- stream response back --
  const outHeaders = new Headers();
  upstream.headers.forEach((v, k) => {
    const lk = k.toLowerCase();
    // node-fetch AUTO-DECOMPRESSES gzip/br bodies. Forwarding the original
    // content-encoding/content-length would hand the caller a plain-text
    // body labelled gzip — curl_cffi then dies with CURLE_BAD_CONTENT
    //_ENCODING (61). Both are dropped; the body is already decoded.
    if (
      lk === "transfer-encoding" ||
      lk === "connection" ||
      lk === "content-encoding" ||
      lk === "content-length"
    )
      return;
    outHeaders.set(k, v);
  });
  // Document the tor exit on every response so the caller (glm2api / devweb)
  // can see exactly which exit IP served the request.
  if (exitIp && exitIp !== "unknown") outHeaders.set("x-exit-ip", exitIp);

  const status = upstream.status;
  let bytesReceived = 0;

  if (upstream.body) {
    const nodeReadable = upstream.body;
    const webStream = new ReadableStream<Uint8Array>({
      start(controller) {
        nodeReadable.on("data", (chunk: Buffer) => {
          bumpIdle();
          bytesReceived += chunk.byteLength;
          controller.enqueue(new Uint8Array(chunk));
        });
        nodeReadable.on("end", () => {
          if (idleTimer) clearTimeout(idleTimer);
          pushLog({
            method: req.method,
            path: u.pathname,
            target,
            ip,
            exitIp,
            viaTor: true,
            provider: provider?.id || "—",
            ua,
            referer,
            status,
            durationMs: Date.now() - startedAt,
            bytes: bytesReceived,
            error: null,
          });
          controller.close();
        });
        nodeReadable.on("error", (e) => {
          if (idleTimer) clearTimeout(idleTimer);
          const msg = e instanceof Error ? e.message : String(e);
          pushLog({
            method: req.method,
            path: u.pathname,
            target,
            ip,
            exitIp,
            viaTor: true,
            provider: provider?.id || "—",
            ua,
            referer,
            status: 502,
            durationMs: Date.now() - startedAt,
            bytes: bytesReceived,
            error: msg,
          });
          controller.error(e);
        });
      },
      cancel() {
        if (idleTimer) clearTimeout(idleTimer);
        pushLog({
          method: req.method,
          path: u.pathname,
          target,
          ip,
          exitIp,
          viaTor: true,
          provider: provider?.id || "—",
          ua,
          referer,
          status,
          durationMs: Date.now() - startedAt,
          bytes: bytesReceived,
          error: "client aborted",
        });
        nodeReadable.destroy();
      },
    });
    return new NextResponse(webStream, { status, headers: outHeaders });
  }

  // No body — log immediately
  if (idleTimer) clearTimeout(idleTimer);
  pushLog({
    method: req.method,
    path: u.pathname,
    target,
    ip,
    exitIp,
    viaTor: true,
    provider: provider?.id || "—",
    ua,
    referer,
    status,
    durationMs: Date.now() - startedAt,
    bytes: 0,
    error: null,
  });
  return new NextResponse(null, { status, headers: outHeaders });
}

export {
  handler as GET,
  handler as POST,
  handler as PUT,
  handler as PATCH,
  handler as DELETE,
  handler as HEAD,
  handler as OPTIONS,
};
