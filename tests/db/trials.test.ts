// Database tests for the trial safety rules. They use a throwaway database (bisect_test, dropped
// afterwards) and a fake agent, so they cost nothing. Run: npm run test:db
process.env.MONGODB_DB = "bisect_test";

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { RunRecord, RunTaskOpts } from "@/lib/types";

// Imported after MONGODB_DB is set, so every module sees the test database.
let getClient: typeof import("@/lib/memory/db").getClient;
let getDb: typeof import("@/lib/memory/db").getDb;
let saveRun: typeof import("@/lib/memory/runs").saveRun;
let T: typeof import("@/lib/bisect/trials");

function fakeRun(o: RunTaskOpts, passed: boolean): RunRecord {
  return {
    runId: o.runId, taskId: o.taskId, versionId: o.versionId, trial: o.trial, snapshotId: "s",
    toolCodeVersion: "t", checkerVersion: "c", model: { name: "fake", temperature: 0, maxTokens: 0 },
    contextMode: o.contextMode ?? "normal", activeLessonIds: [], retrievedLessons: [], renderedPromptHash: "",
    toolCalls: [], toolSteps: 0, finalStateSummary: {}, assertions: [{ name: "target", passed }],
    targetAssertion: o.targetAssertion ?? null, outcome: null, error: null, infraRetries: 0,
    tokens: 10, modelCalls: 2, transcript: [], createdAt: new Date(),
  };
}

// A fake agent that saves its run like the real one and counts how often it was called.
function fakeAgent(passed: boolean) {
  const calls: string[] = [];
  const runTask = async (o: RunTaskOpts) => {
    calls.push(o.runId);
    const r = fakeRun(o, passed);
    await saveRun(r);
    return r;
  };
  return { runTask, calls };
}

before(async () => {
  ({ getClient, getDb } = await import("@/lib/memory/db"));
  ({ saveRun } = await import("@/lib/memory/runs"));
  T = await import("@/lib/bisect/trials");
  if ((await getDb()).databaseName !== "bisect_test") throw new Error("refusing to run outside bisect_test");
  await (await getDb()).dropDatabase();
});
after(async () => {
  await (await getDb()).dropDatabase();
  await (await getClient()).close();
});

test("a retried batch never re-runs or double-counts saved trials", async () => {
  await T.openBudget("b-retry", { maxRuns: 100 });
  const agent = fakeAgent(true);
  const opts = { runIdPrefix: "inv-retry-p1", budgetId: "b-retry", targetAssertion: "target", runTask: agent.runTask };
  await T.runTrials("task", "v1", 5, opts);
  await T.runTrials("task", "v1", 5, opts); // the workflow step retried: same fixed runIds
  assert.equal(agent.calls.length, 5, "second call must skip all 5 saved trials");
  const db = await getDb();
  assert.equal(await db.collection("runs").countDocuments({ runId: /^inv-retry-p1-/ }), 5);
  const b = await db.collection("budgets").findOne({ _id: "b-retry" as unknown as never });
  assert.equal(b?.reservedRuns, 5);
  assert.equal(b?.usedRuns, 5);
});

test("concurrent reservations can never exceed the run cap", async () => {
  await T.openBudget("b-cap", { maxRuns: 12 });
  const results = await Promise.allSettled(Array.from({ length: 6 }, () => T.reserveRuns("b-cap", 5)));
  const ok = results.filter((r) => r.status === "fulfilled").length;
  assert.equal(ok, 2, "only two reservations of 5 fit under a cap of 12");
  assert.ok(results.filter((r) => r.status === "rejected").every((r) => (r as PromiseRejectedResult).reason instanceof T.BudgetError));
  const b = await (await getDb()).collection("budgets").findOne({ _id: "b-cap" as unknown as never });
  assert.equal(b?.reservedRuns, 10);
});

test("a batch that doesn't fit the budget starts nothing", async () => {
  await T.openBudget("b-small", { maxRuns: 3 });
  const agent = fakeAgent(true);
  await assert.rejects(
    T.runTrials("task", "v1", 5, { runIdPrefix: "inv-small-p1", budgetId: "b-small", runTask: agent.runTask }),
    T.BudgetError,
  );
  assert.equal(agent.calls.length, 0);
});

test("an infra error that survives its retries is insufficient_evidence, never a pass", async () => {
  await T.openBudget("b-infra", { maxRuns: 100 });
  let attempts = 0;
  const broken = async () => {
    attempts++;
    throw new Error("OpenRouter 503");
  };
  const s = await T.screen({
    key: "gate-t1", ownerId: "ap-infra", budgetId: "b-infra", phase: "search", taskId: "task", versionId: "v1",
    versionIndex: 1, targetAssertion: "target", runTask: broken, retryDelaysMs: [0, 0],
  });
  assert.equal(attempts, 2 * 3, "each of 2 trials: 1 try + 2 retries");
  assert.equal(s.status, "insufficient_evidence");
  assert.equal(s.counts.error, 2);
  assert.notEqual(s.label, "GOOD");
});

test("confirm classifies 5 fresh trials", async () => {
  await T.openBudget("b-confirm", { maxRuns: 100 });
  const bad = fakeAgent(false);
  const p = await T.confirm({
    key: "search-v2", ownerId: "inv-c", budgetId: "b-confirm", phase: "search", taskId: "task", versionId: "v2",
    versionIndex: 2, targetAssertion: "target", runTask: bad.runTask,
  });
  assert.equal(p.label, "BAD");
  assert.deepEqual(p.counts, { pass: 0, targetFail: 5, otherFail: 0, error: 0 });
  assert.equal(p.runIds.length, 5);
});
