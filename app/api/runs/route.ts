import { NextResponse } from "next/server";
import { baselineVersionId } from "@/lib/agent/baseline";
import { runTask } from "@/lib/agent/runner";
import { getTask } from "@/lib/data";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

// Runs one task once on one version (default: the no-lesson baseline) and returns the result.
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { taskId?: string; versionId?: string };
  if (!body.taskId) return NextResponse.json({ error: "taskId is required" }, { status: 400 });
  try {
    await getTask(body.taskId);
  } catch {
    return NextResponse.json({ error: `unknown task ${body.taskId}` }, { status: 400 });
  }
  const t0 = Date.now();
  const versionId = body.versionId ?? (await baselineVersionId());
  const runId = `adhoc-${t0}-${Math.random().toString(36).slice(2, 6)}`;
  const run = await runTask({ taskId: body.taskId, versionId, trial: 0, runId });
  return NextResponse.json({
    runId,
    taskId: run.taskId,
    versionId,
    passed: run.assertions.every((a) => a.passed),
    assertions: run.assertions,
    toolCalls: run.toolCalls.map((c) => `${c.tool}(${JSON.stringify(c.args)}) -> ${JSON.stringify(c.result)}`),
    reply: run.finalStateSummary.finalReply,
    retrievedLessons: run.retrievedLessons,
    modelCalls: run.modelCalls,
    tokens: run.tokens,
    ms: Date.now() - t0,
  });
}
