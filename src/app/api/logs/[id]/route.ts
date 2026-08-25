import { NextRequest, NextResponse } from "next/server";
import { deleteLog } from "@/lib/logs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const ok = deleteLog(id);
  if (!ok) {
    return NextResponse.json(
      { ok: false, error: "not found" },
      { status: 404 },
    );
  }
  return NextResponse.json({ ok: true, deleted: id });
}
