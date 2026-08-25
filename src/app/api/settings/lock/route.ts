import { NextRequest, NextResponse } from "next/server";
import { setDashboardLocked, verifyPassword } from "@/lib/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/settings/lock
 *   Body: { locked: boolean, current: string }
 *
 * Toggles whether the dashboard itself requires a password to view.
 * Requires the current password to authenticate.
 */
export async function POST(req: NextRequest) {
  let body: { locked?: boolean; current?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid JSON body." },
      { status: 400 },
    );
  }

  const current = (body.current || "").trim();
  if (!current) {
    return NextResponse.json(
      { ok: false, error: "Current password is required." },
      { status: 400 },
    );
  }

  const ok = await verifyPassword(current);
  if (!ok) {
    return NextResponse.json(
      { ok: false, error: "Current password is incorrect." },
      { status: 401 },
    );
  }

  await setDashboardLocked(!!body.locked);
  return NextResponse.json({ ok: true, locked: !!body.locked });
}
