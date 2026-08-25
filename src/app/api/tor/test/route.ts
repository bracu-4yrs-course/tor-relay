import { NextRequest, NextResponse } from "next/server";
import nodeFetch from "node-fetch";
import { ensureTorBooted, supervisor } from "@/lib/tor";
import { pushLog } from "@/lib/logs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/tor/test — spin up a fresh Tor circuit (random SOCKS username),
 *  ask ipify what our exit IP is, and log the probe so it shows up in the
 *  dashboard just like a real proxied request.
 *
 *  Uses node-fetch v3 (not native fetch) so the SOCKS `agent` is actually
 *  honored — native fetch silently ignores `agent`, which would make the
 *  probe go direct instead of through Tor.
 */
export async function POST(req: NextRequest) {
  await ensureTorBooted();
  const startedAt = Date.now();
  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0].trim() ||
    req.headers.get("x-real-ip") ||
    "unknown";
  const ua = req.headers.get("user-agent") || "";
  const referer = req.headers.get("referer") || "";

  const { agent, circuit } = supervisor.newAgent();
  const target = "https://api.ipify.org?format=json";

  try {
    const r = await nodeFetch(target, {
      method: "GET",
      // @ts-expect-error node-fetch honors `agent`
      agent,
      headers: { "user-agent": "tor-relay/probe" },
    });
    const text = await r.text();
    let exitIp = "unknown";
    try {
      exitIp = (JSON.parse(text) as { ip?: string }).ip || text.trim();
    } catch {
      exitIp = text.trim();
    }
    pushLog({
      method: "GET",
      path: "/api/tor/test",
      target,
      ip,
      exitIp,
      viaTor: true,
      provider: "ipify",
      ua,
      referer,
      status: r.status,
      durationMs: Date.now() - startedAt,
      bytes: text.length,
      error: null,
    });
    return NextResponse.json({
      ok: true,
      exitIp,
      viaTor: true,
      circuit,
      ms: Date.now() - startedAt,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    pushLog({
      method: "GET",
      path: "/api/tor/test",
      target,
      ip,
      exitIp: "unknown",
      viaTor: true,
      provider: "ipify",
      ua,
      referer,
      status: 502,
      durationMs: Date.now() - startedAt,
      bytes: null,
      error: msg,
    });
    return NextResponse.json(
      { ok: false, error: msg, exitIp: "unknown", circuit },
      { status: 502 },
    );
  }
}
