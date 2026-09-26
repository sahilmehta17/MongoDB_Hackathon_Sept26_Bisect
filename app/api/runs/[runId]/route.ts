import { NextResponse } from "next/server";
import { getRun } from "@/lib/memory/runs";

export const dynamic = "force-dynamic";

// The full run record, for the trace view.
export async function GET(_req: Request, { params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  const run = await getRun(runId);
  if (!run) return NextResponse.json({ error: `run ${runId} not found` }, { status: 404 });
  return NextResponse.json(run);
}
