// Re-measures every number the screens show, on today's build, after the code freeze (spec 9), and
// saves them as one document (config/measurements) that the home page reads. Changes no app code.
// Investigations and the repeat catch run on the deployed app, so their times are real.
// Usage: npm run measure-all -- --app https://<app>.vercel.app [--trials 3] [--session ap2]
import { baselineVersionId } from "@/lib/agent/baseline";
import { confirm, costOf, openBudget, runTrials } from "@/lib/bisect/trials";
import { listTasks } from "@/lib/data";
import { getCalibration } from "@/lib/data/stored";
import { gitCommit } from "@/lib/env";
import { CALIBRATION, IMMUNE_THRESHOLD } from "@/lib/immune/threshold";
import { col } from "@/lib/memory/collections";
import { getClient, getDb } from "@/lib/memory/db";
import { appendVersion, createHistory } from "@/lib/memory/histories";
import { addLesson, createVersion } from "@/lib/memory/lessons";
import type { InvestigationView, Measurements, Rate, Recognition } from "@/lib/types";
import { yamlLessonSeed } from "@/lib/data/yaml";

const arg = (name: string, fallback: string | null = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
};
const APP = arg("app");
const TRIALS = Number(arg("trials", "3"));
const STAMP = `measure-${Date.now()}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Pass rate over the eval tasks: every assertion must pass in a run.
async function passRate(versionId: string, tag: string): Promise<Rate & { versionId: string }> {
  const tasks = await listTasks("eval");
  let pass = 0;
  let total = 0;
  for (let i = 0; i < tasks.length; i += 5) {
    const batch = await Promise.all(
      tasks.slice(i, i + 5).map((t) => runTrials(t.taskId, versionId, TRIALS, { runIdPrefix: `${STAMP}-${tag}-${t.taskId}`, budgetId: STAMP })),
    );
    for (const runs of batch) {
      for (const r of runs) {
        if (r.error) continue; // infra errors are excluded and counted separately, never as pass or fail
        total++;
        if (r.assertions.every((a) => a.passed)) pass++;
      }
    }
  }
  console.log(`  ${tag} on ${versionId}: ${pass}/${total}`);
  return { versionId, pass, total, trials: TRIALS };
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`${APP}${path}`, { ...init, headers: { "content-type": "application/json" } });
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
  return (await r.json()) as T;
}

async function main() {
  if (!APP) throw new Error("usage: npm run measure-all -- --app https://<app>.vercel.app [--trials 3] [--session apN]");
  await openBudget(STAMP, { maxRuns: 2000, maxModelCalls: 20000 });
  const seed = yamlLessonSeed();
  const { histories, antibodies, recognitions, sessions } = await col();

  console.log("viability");
  const zeroLesson = await passRate(await baselineVersionId(), "zero");
  // A fresh agent with only the hand-written useful lessons, one per version.
  const h = await createHistory({ note: `${STAMP}: useful lessons only` });
  let v = h.versionIds[0];
  for (const u of seed.useful) {
    const lesson = await addLesson(u.text, { origin: "seeded", seedId: u.id });
    v = (await createVersion({ parentVersionId: v, change: { op: "add", lessonId: lesson.lessonId }, label: "seeded", createdBy: "seed", note: `${STAMP} ${u.id}` })).versionId;
    await appendVersion(h.historyId, v);
  }
  const usefulLessons = await passRate(v, "useful");

  // Each planted case, fresh: harmful bite on its current version, then a new investigation.
  const planted = await histories.find({ groundTruth: { $exists: true } }).sort({ createdAt: -1 }).toArray();
  const cases = seed.harmful.map((hl) => planted.find((p) => p.groundTruth!.seedId === hl.id)).filter((x) => x !== undefined);
  const harmfulBite: Measurements["viability"]["harmfulBite"] = [];
  const investigations: Measurements["investigations"] = [];
  const afterUndo: Measurements["viability"]["afterUndo"] = [];
  for (const c of cases) {
    const gt = c.groundTruth!;
    const current = c.versionIds[c.versionIds.length - 1];
    const bite = await confirm({ key: `bite-${gt.seedId}`, ownerId: STAMP, budgetId: STAMP, phase: "endpoint", taskId: gt.failingTaskId, versionId: current, versionIndex: -1, targetAssertion: gt.targetAssertion });
    harmfulBite.push({ seedId: gt.seedId, taskId: gt.failingTaskId, versionId: current, targetFail: bite.counts.targetFail, trials: bite.trials });
    console.log(`  ${gt.seedId} bites ${bite.counts.targetFail}/${bite.trials} on ${current}`);

    const started = await api<{ investigationId: string }>("/api/investigations", {
      method: "POST",
      body: JSON.stringify({ historyId: c.historyId, taskId: gt.failingTaskId, target: gt.targetAssertion, ...(c.goodVersionId ? { goodVersionId: c.goodVersionId } : {}) }),
    });
    let view: InvestigationView;
    for (;;) {
      view = await api<InvestigationView>(`/api/investigations/${started.investigationId}`);
      if (view.investigation.verdict !== "running") break;
      await sleep(10_000);
    }
    const inv = view.investigation;
    investigations.push({
      investigationId: inv.investigationId,
      seedId: gt.seedId,
      correct: inv.suspect ? inv.suspect.lessonId === gt.lessonId : false,
      verdict: inv.verdict,
      acceptance: inv.acceptance,
      probes: inv.probes.length + inv.verification.length,
      runs: view.cost.runs,
      modelCalls: view.cost.modelCalls,
      tokens: view.cost.tokens,
      seconds: Math.round(view.elapsedMs / 1000),
    });
    console.log(`  ${inv.investigationId} (${gt.seedId}): ${inv.verdict}, ${inv.acceptance ?? "-"}, named ${inv.suspect?.lessonId ?? "-"} (planted ${gt.lessonId}), ${view.cost.runs} runs, ${Math.round(view.elapsedMs / 1000)} s`);
    if (inv.repairVersionId && inv.acceptance === "accepted") {
      afterUndo.push({ ...(await passRate(inv.repairVersionId, `undo-${gt.seedId}`)), investigationId: inv.investigationId });
    }
  }

  console.log("immune memory");
  const cal = await getCalibration();
  const h1 = investigations.find((i) => i.seedId === "H1" && i.verdict === "verified");
  const h1Repair = h1 ? (await api<InvestigationView>(`/api/investigations/${h1.investigationId}`)).investigation.repairVersionId : null;
  let repeatCatch: Measurements["immune"]["repeatCatch"] = null;
  if (h1Repair && cal?.rewordings.H1?.[0]) {
    const t0 = Date.now();
    const rec = await api<Recognition>("/api/immune/propose", { method: "POST", body: JSON.stringify({ text: cal.rewordings.H1[0], baseVersionId: h1Repair }) });
    repeatCatch = { recognitionId: rec.recognitionId, seconds: Math.round((Date.now() - t0) / 100) / 10, runs: rec.runs };
    console.log(`  repeat catch: ${rec.decision} in ${repeatCatch.seconds} s, ${rec.runs} runs (similarity ${rec.matches[0]?.score.toFixed(3) ?? "-"})`);
  }
  const holdoutRecs = await recognitions.find({ source: "holdout" }).toArray();
  const lookalikes = (cal?.useful ?? []).slice(-3);
  const lookRecs = await recognitions.find({ text: { $in: lookalikes }, decision: { $ne: "no_match" } }).toArray();

  const sessionId = arg("session");
  const s = sessionId ? await sessions.findOne({ sessionId }) : null;
  const count = (t: string) => s?.events.filter((e) => e.type === t).length ?? 0;
  const detected = s?.events.find((e) => e.type === "regression_confirmed");
  const repaired = s?.events.find((e) => e.type === "repair_activated");

  const zeroCost = await costOf(STAMP);
  const m: Measurements = {
    measuredAt: new Date(),
    commit: gitCommit(),
    viability: { zeroLesson, usefulLessons, harmfulBite, afterUndo },
    investigations,
    immune: {
      threshold: IMMUNE_THRESHOLD,
      calibration: CALIBRATION,
      firstCatch: h1 ? { investigationId: h1.investigationId, seconds: h1.seconds, runs: h1.runs } : null,
      repeatCatch,
      holdout: holdoutRecs.length
        ? { total: holdoutRecs.length, recognized: holdoutRecs.filter((r) => r.decision !== "no_match").length, blocked: holdoutRecs.filter((r) => r.decision === "immune_blocked").length }
        : null,
      usefulLookalikes: lookRecs.length ? { matched: lookRecs.length, passed: lookRecs.filter((r) => r.decision === "immune_passed").length } : null,
    },
    autopilot: s
      ? {
          sessionId: s.sessionId,
          proposals: count("proposed"),
          immuneBlocks: count("immune_blocked"),
          gateRejections: count("gate_rejected"),
          activations: count("activated"),
          regressionsCaught: count("regression_confirmed"),
          repairs: count("repair_activated"),
          detectionToRepairSeconds: detected && repaired ? Math.round((new Date(repaired.at).getTime() - new Date(detected.at).getTime()) / 1000) : null,
        }
      : null,
    cost: { runs: zeroCost.runs + investigations.reduce((n, i) => n + i.runs, 0), tokens: zeroCost.tokens + investigations.reduce((n, i) => n + i.tokens, 0) },
  };
  await (await getDb()).collection<{ _id: string; data: Measurements; updatedAt: Date }>("config").replaceOne({ _id: "measurements" }, { data: m, updatedAt: new Date() }, { upsert: true });
  console.log(`\nsaved measurements (${m.cost.runs} runs, ${m.cost.tokens} tokens); antibodies now: ${await antibodies.countDocuments()}`);
  console.log(JSON.stringify({ zero: m.viability.zeroLesson, useful: m.viability.usefulLessons, immune: m.immune }, null, 1));
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(async () => (await getClient()).close());
