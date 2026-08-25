import { NextRequest, NextResponse } from "next/server";
import { verifyPassword, hasPassword, isOpenRelay } from "@/lib/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/auth
 *   Body: { password: string }
 *   Response: { ok: boolean, authenticated: boolean, openRelay: boolean }
 *
 * Verifies a password against the stored hash. Does NOT set a cookie — the
 * client just passes the password via the `x-tor-relay-auth` header on every
 * authenticated request, which the protected endpoints check.
 *
 * This is intentionally simple (no session, no cookie). The dashboard keeps
 * the password in memory (Zustand) and sends it on each call. Clearing the
 * browser tab clears the auth.
 */
export async function POST(req: NextRequest) {
  let body: { password?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid JSON body." },
      { status: 400 },
    );
  }

  const open = await isOpenRelay();
  if (open) {
    return NextResponse.json({
      ok: true,
      authenticated: true,
      openRelay: true,
      message: "Open relay — no password required.",
    });
  }

  const pwd = (body.password || "").trim();
  if (!pwd) {
    return NextResponse.json(
      { ok: false, error: "Password is required." },
      { status: 400 },
    );
  }

  const ok = await verifyPassword(pwd);
  if (!ok) {
    return NextResponse.json(
      { ok: false, authenticated: false, error: "Incorrect password." },
      { status: 401 },
    );
  }

  return NextResponse.json({
    ok: true,
    authenticated: true,
    openRelay: false,
  });
}

export async function GET(_req: NextRequest) {
  const has = await hasPassword();
  const open = await isOpenRelay();
  return NextResponse.json({
    requiresPassword: !open,
    hasPassword: has,
    openRelay: open,
  });
}
