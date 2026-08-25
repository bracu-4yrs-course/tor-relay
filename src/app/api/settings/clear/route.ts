import { NextRequest, NextResponse } from "next/server";
import { clearPassword, verifyPassword } from "@/lib/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/settings/clear
 *   Body: { current: string }
 *
 * Clears the stored password (reverts to env var / open relay). Requires
 * the current password to authenticate.
 */
export async function POST(req: NextRequest) {
  let body: { current?: string };
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

  const result = await clearPassword(current);
  if (!result.ok) {
    return NextResponse.json(result, { status: 400 });
  }
  return NextResponse.json(result);
}
