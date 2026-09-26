import { NextResponse } from "next/server";
import { immuneView } from "@/lib/immune/view";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(await immuneView());
}
