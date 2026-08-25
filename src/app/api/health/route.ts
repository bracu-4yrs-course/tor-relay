import { NextRequest, NextResponse } from "next/server";
import { ensureTorBooted, supervisor } from "@/lib/tor";
import { requireAuthIfLocked } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  // If dashboard is locked, hide everything — return 404 to anyone
  // without the password. No hint that this is even a tor relay.
  const auth = await requireAuthIfLocked(req);
  if (!auth.ok) return auth.response;

  await ensureTorBooted();
  const tor = supervisor.status();
  return NextResponse.json(
    {
      ok: true,
      worker: "tor-relay-node",
      streaming: true,
      tor: tor.state,
      socks: tor.socks,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
