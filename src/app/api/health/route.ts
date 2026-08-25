import { NextRequest, NextResponse } from "next/server";
import { ensureTorBooted, supervisor } from "@/lib/tor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest) {
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
