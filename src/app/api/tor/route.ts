import { NextRequest, NextResponse } from "next/server";
import { ensureTorBooted, supervisor } from "@/lib/tor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/tor — supervisor status (state, pid, recent log lines). */
export async function GET(_req: NextRequest) {
  await ensureTorBooted();
  return NextResponse.json(
    { tor: supervisor.status() },
    { headers: { "Cache-Control": "no-store" } },
  );
}
