import { NextRequest, NextResponse } from "next/server";
import { clearLogs, getAllLogs } from "@/lib/logs";
import { requireAuthIfLocked } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const auth = await requireAuthIfLocked(req);
  if (!auth.ok) return auth.response;

  return NextResponse.json(
    { logs: getAllLogs() },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function DELETE(req: NextRequest) {
  const auth = await requireAuthIfLocked(req);
  if (!auth.ok) return auth.response;

  clearLogs();
  return NextResponse.json({ ok: true, cleared: true });
}
