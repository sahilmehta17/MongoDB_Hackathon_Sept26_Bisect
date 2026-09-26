import { NextResponse } from "next/server";
import { getDb } from "@/lib/memory/db";
import type { Measurements } from "@/lib/types";

export const dynamic = "force-dynamic";

// The numbers measured by scripts/measure-all.ts after the freeze, or null before that.
export async function GET() {
  const doc = await (await getDb()).collection<{ _id: string; data: Measurements }>("config").findOne({ _id: "measurements" });
  return NextResponse.json(doc?.data ?? null);
}
