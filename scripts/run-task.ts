// Run one task once and print what happened.
// Usage: npm run run-task -- <taskId> [versionId]
import { baselineVersionId } from "@/lib/agent/baseline";
import { runTask } from "@/lib/agent/runner";
import { getClient } from "@/lib/memory/db";

async function main() {
  const [taskId, versionArg] = process.argv.slice(2);
  if (!taskId) throw new Error("usage: npm run run-task -- <taskId> [versionId]");
  const versionId = versionArg ?? (await baselineVersionId());
  const t0 = Date.now();
  const run = await runTask({ taskId, versionId, trial: 0, runId: `cli-${t0}-${taskId}` });
  console.log(`${run.runId} on ${versionId} (${((Date.now() - t0) / 1000).toFixed(1)} s, ${run.modelCalls} model calls, ${run.tokens} tokens)`);
  console.log("lessons seen:", run.retrievedLessons.map((l) => `${l.id}${l.trigger ? ` [after: ${l.trigger}]` : ""}`).join(", ") || "(none)");
  run.toolCalls.forEach((c, i) => console.log(`  ${i + 1}. ${c.tool}(${JSON.stringify(c.args)}) -> ${JSON.stringify(c.result)}`));
  console.log("reply:", run.finalStateSummary.finalReply);
  run.assertions.forEach((a) => console.log(`  ${a.passed ? "PASS" : "FAIL"} ${a.name}`));
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(async () => (await getClient()).close());
