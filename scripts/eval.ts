// Pass rate of one version over a split of tasks (default: eval tasks, 1 trial, baseline version).
// Usage: npm run eval -- [versionId] [--trials N] [--split eval|training]
import { baselineVersionId } from "@/lib/agent/baseline";
import { runTask } from "@/lib/agent/runner";
import { listTasks } from "@/lib/data";
import { getClient } from "@/lib/memory/db";
import { LIMITS } from "@/lib/types";

function flag(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
}

async function main() {
  const positional = process.argv.slice(2).filter((a, i, all) => !a.startsWith("--") && !all[i - 1]?.startsWith("--"));
  const versionId = positional[0] ?? (await baselineVersionId());
  const trials = Number(flag("trials", "1"));
  const split = flag("split", "eval") as "eval" | "training";
  const tasks = await listTasks(split);
  const stamp = Date.now();
  const jobs = tasks.flatMap((t) => Array.from({ length: trials }, (_, n) => ({ t, n })));
  const results: { taskId: string; workflow: string; passed: boolean | null; tokens: number }[] = [];
  let next = 0;
  const t0 = Date.now();
  async function worker() {
    while (next < jobs.length) {
      const { t, n } = jobs[next++];
      try {
        const run = await runTask({ taskId: t.taskId, versionId, trial: n, runId: `eval-${stamp}-${t.taskId}-t${n}` });
        const passed = run.assertions.every((a) => a.passed);
        results.push({ taskId: t.taskId, workflow: t.workflow, passed, tokens: run.tokens });
        console.log(`${passed ? "PASS" : "FAIL"} ${t.taskId} t${n}${passed ? "" : "  " + run.assertions.filter((a) => !a.passed).map((a) => a.name).join(",")}`);
      } catch (e) {
        results.push({ taskId: t.taskId, workflow: t.workflow, passed: null, tokens: 0 });
        console.log(`ERROR ${t.taskId} t${n}: ${e instanceof Error ? e.message : e}`);
      }
    }
  }
  await Promise.all(Array.from({ length: LIMITS.concurrency }, worker));
  const done = results.filter((r) => r.passed !== null);
  const pass = done.filter((r) => r.passed).length;
  console.log(`\n${versionId}, ${split}, ${trials} trial(s): ${pass}/${done.length} passed = ${((100 * pass) / Math.max(1, done.length)).toFixed(0)}%`);
  for (const wf of [...new Set(done.map((r) => r.workflow))]) {
    const w = done.filter((r) => r.workflow === wf);
    console.log(`  ${wf}: ${w.filter((r) => r.passed).length}/${w.length}`);
  }
  console.log(`errors: ${results.length - done.length}, tokens: ${results.reduce((s, r) => s + r.tokens, 0)}, time: ${((Date.now() - t0) / 1000).toFixed(0)} s`);
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(async () => (await getClient()).close());
