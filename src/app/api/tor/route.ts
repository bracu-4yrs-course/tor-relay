import { NextRequest, NextResponse } from "next/server";
import { ensureTorBooted, supervisor } from "@/lib/tor";
import { requireAuthIfLocked } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/tor — supervisor status. 404 when dashboard is locked. */
export async function GET(req: NextRequest) {
  const auth = await requireAuthIfLocked(req);
  if (!auth.ok) return auth.response;

  await ensureTorBooted();
  return NextResponse.json(
    { tor: supervisor.status() },
    { headers: { "Cache-Control": "no-store" } },
  );
}
