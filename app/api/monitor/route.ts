import { NextResponse } from "next/server";
import { start } from "workflow/api";
import { pickTarget, regressionDecision } from "@/lib/bisect/evidence";
import { createInvestigation, logInv } from "@/lib/bisect/investigation";
import { confirm, openBudget, screen } from "@/lib/bisect/trials";
import { getTask } from "@/lib/data";
import { getAutopilotSets } from "@/lib/data/stored";
import { getHistory } from "@/lib/memory/histories";
import { getRunsByIds } from "@/lib/memory/runs";
import { investigate } from "@/workflows/investigate";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// The spec's hard fallback: "regressions trigger Bisect automatically".
// POST { historyId, goodVersionId? } screens the monitoring set on the history's latest version
// (2 trials); a failure confirms (5 trials); BAD starts an investigation with no clicks.
export async function POST(req: Request) {
  const { historyId, goodVersionId } = (await req.json().catch(() => ({}))) as { historyId?: string; goodVersionId?: string };
  if (!historyId) return NextResponse.json({ error: "historyId is required" }, { status: 400 });
  const sets = await getAutopilotSets();
  if (!sets) return NextResponse.json({ error: "data/autopilot_sets.yaml hasn't been loaded yet" }, { status: 409 });
  const history = await getHistory(historyId).catch(() => null);
  if (!history) return NextResponse.json({ error: `history ${historyId} not found` }, { status: 400 });
  const versionId = history.versionIds[history.versionIds.length - 1];
  const ownerId = `mon-${historyId}-${versionId}`;
  await openBudget(ownerId, { maxRuns: sets.monitoring.length * 7 });

  const results = [];
  for (const taskId of sets.monitoring) {
    const base = { ownerId, budgetId: ownerId, taskId, versionId, versionIndex: -1 };
    const s = await screen({ ...base, key: `screen-${taskId}`, phase: "monitor", targetAssertion: "_" });
    if (s.status === "ok") {
      results.push({ taskId, screen: s.status, counts: s.counts });
      continue;
    }
    const task = await getTask(taskId);
    const target = pickTarget(await getRunsByIds(s.runIds), [...task.checks.map((c) => c.name), "within_step_limit"]) ?? "_";
    const c = await confirm({ ...base, key: `confirm-${taskId}`, phase: "monitor", targetAssertion: target });
    const decision = regressionDecision(c.label);
    results.push({ taskId, screen: s.status, confirm: c.label, counts: c.counts, target, decision });
    if (decision === "regression_confirmed") {
      const investigationId = await createInvestigation({ historyId, taskId, target, goodVersionId, badVersionId: versionId, trigger: "monitor" });
      const run = await start(investigate, [{ investigationId }]);
      await logInv(investigationId, `started automatically by monitoring (${ownerId}): ${run.runId}`, { workflowRunId: run.runId });
      return NextResponse.json({ versionId, results, investigationId });
    }
  }
  return NextResponse.json({ versionId, results, investigationId: null });
}
