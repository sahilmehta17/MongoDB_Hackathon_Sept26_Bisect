import { NextResponse } from "next/server";
import { start } from "workflow/api";
import { createInvestigation, InputError, logInv } from "@/lib/bisect/investigation";
import { col } from "@/lib/memory/collections";
import { investigate } from "@/workflows/investigate";

export const dynamic = "force-dynamic";

// POST { historyId, taskId, target, goodVersionId?, badVersionId? } → starts an investigation.
// If the same case is already running, returns that one instead of starting a second (cost, rate limits).
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as Record<string, string | undefined>;
  const { historyId, taskId, target, goodVersionId, badVersionId } = body;
  if (!historyId || !taskId || !target) {
    return NextResponse.json({ error: "historyId, taskId and target are required" }, { status: 400 });
  }
  const { investigations } = await col();
  const running = await investigations.findOne(
    { historyId, failureTaskId: taskId, targetAssertion: target, verdict: "running" },
    { projection: { _id: 0, investigationId: 1, workflowRunId: 1 } },
  );
  if (running) return NextResponse.json({ ...running, alreadyRunning: true });

  let investigationId: string;
  try {
    investigationId = await createInvestigation({ historyId, taskId, target, goodVersionId, badVersionId });
  } catch (e) {
    if (e instanceof InputError) return NextResponse.json({ error: e.message }, { status: 400 });
    throw e;
  }
  const run = await start(investigate, [{ investigationId }]);
  await logInv(investigationId, `workflow started: ${run.runId}`, { workflowRunId: run.runId });
  return NextResponse.json({ investigationId, workflowRunId: run.runId });
}

// Newest first, for the home page.
export async function GET() {
  const { investigations } = await col();
  const list = await investigations
    .find(
      {},
      {
        projection: {
          _id: 0, investigationId: 1, historyId: 1, trigger: 1, failureTaskId: 1, targetAssertion: 1,
          verdict: 1, acceptance: 1, suspect: 1, antibodyId: 1, startedAt: 1, finishedAt: 1,
        },
      },
    )
    .sort({ startedAt: -1 })
    .limit(50)
    .toArray();
  return NextResponse.json(list);
}
