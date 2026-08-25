import { NextRequest, NextResponse } from "next/server";
import { providersSummary } from "@/lib/providers";
import { requireAuthIfLocked } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  // If locked, 404 — no hint about what providers exist.
  const auth = await requireAuthIfLocked(req);
  if (!auth.ok) return auth.response;

  return NextResponse.json(
    { providers: providersSummary() },
    { headers: { "Cache-Control": "no-store" } },
  );
}
