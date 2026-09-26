import { NextResponse } from "next/server";
import { investigationView } from "@/lib/bisect/investigation";

export const dynamic = "force-dynamic";

// Everything the results page needs (InvestigationView).
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    return NextResponse.json(await investigationView(id));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: msg.includes("not found") ? 404 : 500 });
  }
}
