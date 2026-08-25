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
 * Hits api.ipify.org through the SAME circuit so the captured IP is the one
 * that will be used for the real upstream request. In mock / disabled mode,
 * agent is undefined, so this just probes the machine's own public IP.
 *
 * BUG FIX (v2): native Node fetch (undici) silently ignores the `agent`
 * option, so the SOCKS routing was a no-op in v1. We now use node-fetch v3,
 * which honors `agent` and actually routes through SOCKS.
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
      headers: { "user-agent": "tor-relay/probe" },
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
 * tor-relay proxy — streaming, allowlisted, **Tor-routed with fresh exit IP per request**.
 *
 * Contract (compatible with the original python tor-relay):
 *   ANY  /api/proxy?url=<enc>   → relay to (allowlisted) target via Tor
 *   Auth: PROXY_KEY env OR DB-stored password
 *         → ?key= or X-Proxy-Key header
 *
 * Bodies stream straight through (no buffering) — SSE-safe.
 *
 * Dashboard contract:
 *   Every request gets a log entry with `exitIp` = the Tor exit IP that
 *   was used to forward the request. This is what makes tor-relay's
 *   dashboard distinct from vertex-proxy-zai's: the column shows "which
 *   IP the request was routed out through to the URL".
 */
async function handler(req: NextRequest) {
  await ensureTorBooted();
  const startedAt = Date.now();
  const u = new URL(req.url);
  const ip = clientIP(req);
  const ua = req.headers.get("user-agent") || "";
  const referer = req.headers.get("referer") || "";

  // -- proxy auth --
  // Order of precedence: DB-stored password hash > env var PROXY_KEY.
  // If neither is set, the relay is "open" (no auth).
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

  // -- allocate a fresh Tor circuit (fresh exit IP) --
  const { agent, mock } = supervisor.newAgent();
  const controller = new AbortController();
  const probeTimeout = setTimeout(() => controller.abort(), 30_000);

  // -- probe exit IP via the same circuit, before the real request --
  // BUG FIX (v2): in mock mode, skip the probe and just use the mock pool.
  // The old code always called probeExitIp, which made a real network
  // request even in mock mode (wasteful, and could fail in sandboxes
  // without outbound network).
  let exitIp = "unknown";
  if (mock) {
    exitIp = supervisor.popMockExitIp();
  } else {
    const probe = await probeExitIp(agent, controller.signal);
    exitIp = probe.exitIp;
  }

  // -- forward headers (strip hop-by-hop) --
  const upstreamHeaders: Record<string, string> = {};
  req.headers.forEach((v, k) => {
    if (!HOP_HEADERS.has(k.toLowerCase())) upstreamHeaders[k] = v;
  });

  // -- streaming fetch through the same SOCKS circuit (via node-fetch) --
  let upstream: nodeFetch.Response;
  try {
    // For GET/HEAD there's no request body; for others we stream req.body
    // through. node-fetch v3 accepts a Node ReadableStream as `body`.
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
      // node-fetch v3 wants a Node Readable / Buffer. Next's req.body is a
      // Web ReadableStream — convert via web-stream-to-node or just buffer.
      // For SSE-safe streaming we'd ideally tee, but most relay use cases
      // are bounded request bodies (LLM prompts); buffering is fine here.
      fetchOpts.body = Buffer.from(await req.arrayBuffer());
    }
    upstream = await nodeFetch(targetURL.toString(), fetchOpts);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    clearTimeout(probeTimeout);
    pushLog({
      method: req.method,
      path: u.pathname,
      target,
      ip,
      exitIp,
      viaTor: !mock,
      provider: provider?.id || "—",
      ua,
      referer,
      status: 502,
      durationMs: Date.now() - startedAt,
      bytes: null,
      error: msg,
    });
    return NextResponse.json({ error: msg }, { status: 502 });
  }

  // -- stream response back --
  const outHeaders = new Headers();
  upstream.headers.forEach((v, k) => {
    const lk = k.toLowerCase();
    if (lk === "transfer-encoding" || lk === "connection") return;
    outHeaders.set(k, v);
  });

  const status = upstream.status;
  let bytesReceived = 0;

  if (upstream.body) {
    // node-fetch's body is a Node Readable; wrap as a Web ReadableStream
    // for NextResponse.
    const nodeReadable = upstream.body;
    const webStream = new ReadableStream<Uint8Array>({
      start(controller) {
        nodeReadable.on("data", (chunk: Buffer) => {
          bytesReceived += chunk.byteLength;
          controller.enqueue(new Uint8Array(chunk));
        });
        nodeReadable.on("end", () => {
          clearTimeout(probeTimeout);
          pushLog({
            method: req.method,
            path: u.pathname,
            target,
            ip,
            exitIp,
            viaTor: !mock,
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
          clearTimeout(probeTimeout);
          const msg = e instanceof Error ? e.message : String(e);
          pushLog({
            method: req.method,
            path: u.pathname,
            target,
            ip,
            exitIp,
            viaTor: !mock,
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
        clearTimeout(probeTimeout);
        pushLog({
          method: req.method,
          path: u.pathname,
          target,
          ip,
          exitIp,
          viaTor: !mock,
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
  clearTimeout(probeTimeout);
  pushLog({
    method: req.method,
    path: u.pathname,
    target,
    ip,
    exitIp,
    viaTor: !mock,
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
