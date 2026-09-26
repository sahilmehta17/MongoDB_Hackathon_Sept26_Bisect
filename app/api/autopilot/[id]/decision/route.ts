import { NextResponse } from "next/server";
import { col } from "@/lib/memory/collections";

export const dynamic = "force-dynamic";

// Approve or reject a repair that needs a person's decision. POST { decision: "approve" | "reject" }
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { decision } = (await req.json().catch(() => ({}))) as { decision?: string };
  if (decision !== "approve" && decision !== "reject") {
    return NextResponse.json({ error: 'decision must be "approve" or "reject"' }, { status: 400 });
  }
  const { sessions } = await col();
  const r = await sessions.updateOne({ sessionId: id, status: "awaiting_decision", decision: null }, { $set: { decision } });
  if (!r.modifiedCount) return NextResponse.json({ error: `session ${id} isn't waiting for a decision` }, { status: 409 });
  return NextResponse.json({ sessionId: id, decision });
}
