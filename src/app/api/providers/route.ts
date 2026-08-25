import { NextRequest, NextResponse } from "next/server";
import { providersSummary } from "@/lib/providers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(_req: NextRequest) {
  return NextResponse.json(
    { providers: providersSummary() },
    { headers: { "Cache-Control": "no-store" } },
  );
}
