// Fresh trials of one task on one version, with the spec's safety rules built in:
// - every trial has a fixed runId (prefix-tN) and is skipped if already saved, so a retried
//   workflow step never re-runs (or pays for) a trial twice;
// - the runs are reserved on a budget with one conditional atomic update before any starts;
// - infrastructure errors are retried at most twice, then saved as an error run (never a pass/fail).
import { classify, countOutcomes, screenStatus, type ScreenStatus } from "@/lib/bisect/evidence";
import { col } from "@/lib/memory/collections";
import { getRunsByIds, saveRun } from "@/lib/memory/runs";
import type { Budget, ContextMode, Cost, Probe, RunRecord, RunTaskOpts } from "@/lib/types";
import { LIMITS } from "@/lib/types";

export class BudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BudgetError";
  }
}

// ---------- budget ----------

export async function openBudget(budgetId: string, max: { maxRuns?: number; maxModelCalls?: number } = {}): Promise<void> {
  const { budgets } = await col();
  const doc: Budget = {
    _id: budgetId,
    maxRuns: max.maxRuns ?? LIMITS.maxRuns,
    maxModelCalls: max.maxModelCalls ?? LIMITS.maxModelCalls,
    reservedRuns: 0,
    usedRuns: 0,
    modelCalls: 0,
    tokens: 0,
  };
  await budgets.updateOne({ _id: budgetId }, { $setOnInsert: doc }, { upsert: true });
}

// Reserve n runs, or throw without starting anything. One conditional update, so concurrent
// reservations can never exceed the cap together.
export async function reserveRuns(budgetId: string, n: number): Promise<void> {
  if (n <= 0) return;
  const { budgets } = await col();
  const ok = await budgets.findOneAndUpdate(
    {
      _id: budgetId,
      $expr: { $and: [{ $lte: [{ $add: ["$reservedRuns", n] }, "$maxRuns"] }, { $lt: ["$modelCalls", "$maxModelCalls"] }] },
    },
    { $inc: { reservedRuns: n } },
  );
  if (!ok) {
    const b = await budgets.findOne({ _id: budgetId });
    throw new BudgetError(
      b
        ? `budget ${budgetId}: ${b.reservedRuns}/${b.maxRuns} runs reserved, ${b.modelCalls}/${b.maxModelCalls} model calls; can't reserve ${n} more`
        : `budget ${budgetId} does not exist`,
    );
  }
}

async function recordUse(budgetId: string, run: RunRecord): Promise<void> {
  const { budgets } = await col();
  await budgets.updateOne({ _id: budgetId }, { $inc: { usedRuns: 1, modelCalls: run.modelCalls, tokens: run.tokens } });
}

// Cost from the saved run records themselves (never from counters), for everything under a prefix.
export async function costOf(runIdPrefix: string): Promise<Cost> {
  const { runs } = await col();
  const escaped = runIdPrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const [agg] = await runs
    .aggregate<Cost>([
      { $match: { runId: { $regex: `^${escaped}-` } } },
      {
        $group: {
          _id: null,
          runs: { $sum: 1 },
          modelCalls: { $sum: "$modelCalls" },
          tokens: { $sum: "$tokens" },
          errors: { $sum: { $cond: [{ $ne: ["$error", null] }, 1, 0] } },
        },
      },
      { $project: { _id: 0 } },
    ])
    .toArray();
  return agg ?? { runs: 0, modelCalls: 0, tokens: 0, errors: 0 };
}

// ---------- trials ----------

export type RunTaskFn = (opts: RunTaskOpts) => Promise<RunRecord>;

export interface TrialOpts {
  runIdPrefix: string; // runIds are `${runIdPrefix}-t${n}`
  budgetId: string;
  targetAssertion?: string;
  contextMode?: ContextMode;
  frozenLessonIds?: string[];
  runTask?: RunTaskFn; // injectable for tests
  retryDelaysMs?: number[]; // tests use [0, 0]
}

export async function runTrials(taskId: string, versionId: string, n: number, opts: TrialOpts): Promise<RunRecord[]> {
  const runTask = opts.runTask ?? (await import("@/lib/agent/runner")).runTask;
  const ids = Array.from({ length: n }, (_, t) => `${opts.runIdPrefix}-t${t}`);
  const saved = new Map((await getRunsByIds(ids)).map((r) => [r.runId, r]));
  const todo = ids.map((runId, trial) => ({ runId, trial })).filter(({ runId }) => !saved.has(runId));

  await reserveRuns(opts.budgetId, todo.length); // throws before anything starts

  let next = 0;
  const worker = async () => {
    while (next < todo.length) {
      const { runId, trial } = todo[next++];
      const run = await runWithRetries(runTask, { taskId, versionId, trial, runId, ...pick(opts) }, opts.retryDelaysMs);
      await recordUse(opts.budgetId, run);
      saved.set(runId, run);
    }
  };
  await Promise.all(Array.from({ length: Math.min(LIMITS.concurrency, todo.length) }, worker));
  return ids.map((id) => saved.get(id)!);
}

const pick = (o: TrialOpts) => ({
  contextMode: o.contextMode ?? "normal",
  frozenLessonIds: o.frozenLessonIds,
  targetAssertion: o.targetAssertion,
});

// Wait before an infra retry, so a rate limit or a burst of in-flight requests can settle.
export const RETRY_DELAYS_MS = [3_000, 8_000];

async function runWithRetries(runTask: RunTaskFn, opts: RunTaskOpts, delays = RETRY_DELAYS_MS): Promise<RunRecord> {
  let last: unknown;
  for (let attempt = 0; attempt <= LIMITS.maxInfraRetries; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, delays[attempt - 1] ?? 0));
    try {
      const run = await runTask(opts);
      if (attempt > 0) {
        run.infraRetries = attempt;
        await saveRun(run);
      }
      return run;
    } catch (e) {
      last = e;
    }
  }
  // Out of retries: record the run as an infrastructure error. It is excluded from pass/fail
  // counts and shown as an error.
  const error = last instanceof Error ? last.message : String(last);
  const run: RunRecord = {
    runId: opts.runId,
    taskId: opts.taskId,
    versionId: opts.versionId,
    trial: opts.trial,
    snapshotId: "",
    toolCodeVersion: "",
    checkerVersion: "",
    model: { name: "", temperature: 0, maxTokens: 0 },
    contextMode: opts.contextMode ?? "normal",
    activeLessonIds: [],
    retrievedLessons: [],
    renderedPromptHash: "",
    toolCalls: [],
    toolSteps: 0,
    finalStateSummary: {},
    assertions: [],
    targetAssertion: opts.targetAssertion ?? null,
    outcome: opts.targetAssertion ? "error" : null,
    error: error.slice(0, 500),
    infraRetries: LIMITS.maxInfraRetries,
    tokens: 0,
    modelCalls: 0,
    transcript: [],
    createdAt: new Date(),
  };
  await saveRun(run);
  return run;
}

// ---------- confirm and screen ----------

export interface ProbeArgs {
  key: string; // stable key, also the runId prefix suffix
  ownerId: string; // investigation or session id: runIds are `${ownerId}-${key}-tN`
  budgetId: string;
  phase: Probe["phase"];
  config?: Probe["config"];
  taskId: string;
  versionId: string;
  versionIndex: number;
  targetAssertion: string;
  contextMode?: ContextMode;
  frozenLessonIds?: string[];
  runTask?: RunTaskFn;
  retryDelaysMs?: number[];
}

async function probeWith(trials: number, a: ProbeArgs): Promise<{ probe: Omit<Probe, "label">; runs: RunRecord[] }> {
  const runs = await runTrials(a.taskId, a.versionId, trials, {
    runIdPrefix: `${a.ownerId}-${a.key}`,
    budgetId: a.budgetId,
    targetAssertion: a.targetAssertion,
    contextMode: a.contextMode,
    frozenLessonIds: a.frozenLessonIds,
    runTask: a.runTask,
    retryDelaysMs: a.retryDelaysMs,
  });
  return {
    runs,
    probe: {
      key: a.key,
      phase: a.phase,
      config: a.config,
      versionId: a.versionId,
      versionIndex: a.versionIndex,
      taskId: a.taskId,
      contextMode: a.contextMode ?? "normal",
      counts: countOutcomes(runs, a.targetAssertion),
      trials,
      runIds: runs.map((r) => r.runId),
    },
  };
}

// Confirm: 5 trials, classified GOOD / BAD / INCONCLUSIVE.
export async function confirm(a: ProbeArgs): Promise<Probe> {
  const { probe } = await probeWith(LIMITS.confirmTrials, a);
  return { ...probe, label: classify(probe.counts, probe.trials) };
}

// Screen: 2 trials. The probe's label is GOOD only when both pass; otherwise INCONCLUSIVE
// (a screen can't show BAD). Use `status` for the decision.
export async function screen(a: ProbeArgs): Promise<Probe & { status: ScreenStatus }> {
  const { probe } = await probeWith(LIMITS.screenTrials, a);
  const status = screenStatus(probe.counts, probe.trials);
  return { ...probe, label: status === "ok" ? "GOOD" : "INCONCLUSIVE", status };
}
