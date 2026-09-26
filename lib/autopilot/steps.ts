// The work behind each step of workflows/autopilot.ts. Each function does one job, is safe to
// repeat (fixed runIds, keyed events), and records what it saw as a session event with evidence.
// All decisions use the fixed evidence rules (spec section 4).
import { proposeLesson, type Proposal } from "@/lib/agent/learn";
import { regressionDecision } from "@/lib/bisect/evidence";
import { confirm, openBudget, runTrials, screen } from "@/lib/bisect/trials";
import { getTask } from "@/lib/data";
import { NotCalibratedError, recognize } from "@/lib/immune/recognize";
import { col, nextId } from "@/lib/memory/collections";
import { appendVersion, createHistory } from "@/lib/memory/histories";
import { addLesson, createVersion, setVersionStatus } from "@/lib/memory/lessons";
import { getRunsByIds } from "@/lib/memory/runs";
import type { AutopilotEvent, AutopilotSession, EvidenceItem, Origin, Probe, StreamItem } from "@/lib/types";
import { LIMITS } from "@/lib/types";

// Session-level run budget (investigations have their own 300-run budgets).
export const SESSION_MAX_RUNS = 600;
export const SESSION_MAX_MODEL_CALLS = 3000;
export const MONITOR_EVERY = 3; // activations between monitoring checks

export async function getSession(sessionId: string): Promise<AutopilotSession> {
  const { sessions } = await col();
  const s = await sessions.findOne({ sessionId }, { projection: { _id: 0 } });
  if (!s) throw new Error(`autopilot session ${sessionId} not found`);
  return s as AutopilotSession;
}

type NewEvent = Omit<AutopilotEvent, "seq" | "at">;

// Append an event unless one with the same key exists (one atomic update).
export async function addEvent(sessionId: string, e: NewEvent, set: Partial<AutopilotSession> = {}): Promise<void> {
  const { sessions } = await col();
  const clean = Object.fromEntries(Object.entries(e).filter(([, v]) => v !== undefined));
  await sessions.updateOne({ sessionId }, [
    {
      $set: {
        ...set,
        events: {
          $cond: [
            { $in: [e.key, "$events.key"] },
            "$events",
            { $concatArrays: ["$events", [{ ...clean, seq: { $size: "$events" }, at: "$$NOW" }]] },
          ],
        },
      },
    },
  ]);
}

const ev = (p: Probe, kind: EvidenceItem["kind"], status?: EvidenceItem["status"]): EvidenceItem => ({
  taskId: p.taskId,
  versionId: p.versionId,
  kind,
  ...(status ? { status } : { label: p.label }),
  counts: p.counts,
  trials: p.trials,
  runIds: p.runIds,
});

// The most common failed assertion across some runs: the target to confirm a screen failure on.
async function mostFailed(runIds: string[]): Promise<string | null> {
  const runs = await getRunsByIds(runIds);
  const n = new Map<string, number>();
  for (const r of runs) for (const a of r.assertions) if (!a.passed) n.set(a.name, (n.get(a.name) ?? 0) + 1);
  return [...n.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null;
}

// ---------- session ----------

export async function createSession(o: { stream: StreamItem[]; sets: AutopilotSession["sets"] }): Promise<string> {
  const { sessions } = await col();
  const sessionId = await nextId("ap");
  const history = await createHistory({ note: `autopilot ${sessionId}` });
  const root = history.versionIds[0];
  await openBudget(sessionId, { maxRuns: SESSION_MAX_RUNS, maxModelCalls: SESSION_MAX_MODEL_CALLS });
  const s: AutopilotSession = {
    sessionId,
    status: "running",
    historyId: history.historyId,
    startVersionId: root,
    activeVersionId: root,
    candidateVersionId: null,
    stream: o.stream,
    position: 0,
    sets: o.sets,
    status0: {},
    activations: 0,
    activationsAtLastMonitor: 0,
    lastMonitorOkVersionId: root,
    pendingRepair: null,
    decision: null,
    events: [],
    createdAt: new Date(),
  };
  await sessions.insertOne({ ...s });
  return sessionId;
}

// Screen every gate and monitoring task on the starting version, so "previously GOOD" is known.
export async function establishBaseline(sessionId: string): Promise<void> {
  const s = await getSession(sessionId);
  if (Object.keys(s.status0).length) return;
  const tasks = [...new Set([...s.sets.gate, ...s.sets.monitoring])];
  const evidence: EvidenceItem[] = [];
  const status0: AutopilotSession["status0"] = {};
  for (let i = 0; i < tasks.length; i += LIMITS.recheckBatch) {
    const probes = await Promise.all(
      tasks.slice(i, i + LIMITS.recheckBatch).map((taskId) =>
        screen({ key: `base-${taskId}`, ownerId: sessionId, budgetId: sessionId, phase: "gate", taskId, versionId: s.activeVersionId, versionIndex: 0, targetAssertion: "_" }),
      ),
    );
    for (const p of probes) {
      status0[p.taskId] = p.status === "ok" ? "GOOD" : "not_good";
      evidence.push(ev(p, "baseline", p.status));
    }
  }
  const good = Object.values(status0).filter((x) => x === "GOOD").length;
  await addEvent(
    sessionId,
    { key: "start", type: "session_started", versionId: s.activeVersionId, evidence, msg: `started on ${s.activeVersionId}; ${good}/${tasks.length} gate and monitoring tasks pass (screened, 2 trials)` },
    { status0 },
  );
}

// ---------- learning ----------

export async function trainingRun(sessionId: string, pos: number, taskId: string): Promise<{ passed: boolean; runId: string }> {
  const s = await getSession(sessionId);
  const [run] = await runTrials(taskId, s.activeVersionId, 1, { runIdPrefix: `${sessionId}-s${pos}-train`, budgetId: sessionId });
  const passed = !run.error && run.assertions.every((a) => a.passed);
  await addEvent(sessionId, {
    key: `s${pos}-train`,
    type: "training_run",
    taskId,
    versionId: s.activeVersionId,
    msg: passed ? `${taskId} passed on ${s.activeVersionId}` : `${taskId} failed on ${s.activeVersionId}: ${run.error ?? run.assertions.filter((a) => !a.passed).map((a) => a.name).join(", ")}`,
    runs: 1,
  });
  return { passed, runId: run.runId };
}

export async function propose(sessionId: string, pos: number, runId: string, taskId: string): Promise<Proposal> {
  const [run] = await getRunsByIds([runId]);
  const p = await proposeLesson(run, await getTask(taskId));
  await addEvent(
    sessionId,
    p.rule !== null
      ? { key: `s${pos}-proposed`, type: "proposed", label: "natural", text: p.rule, taskId, msg: `learned from ${taskId}: "${p.rule}"` }
      : { key: `s${pos}-proposed`, type: "no_proposal", taskId, msg: `no lesson proposed from ${taskId} (${"reason" in p ? p.reason : ""})` },
  );
  return p;
}

export async function announce(sessionId: string, pos: number, item: Extract<StreamItem, { text: string }>, label: Origin): Promise<void> {
  await addEvent(sessionId, { key: `s${pos}-proposed`, type: "proposed", label, text: item.text, msg: `${item.note}: "${item.text}"` });
}

// ---------- immune check (spec 6.3) ----------

export async function immuneCheck(sessionId: string, pos: number, text: string, label: Origin): Promise<"immune_blocked" | "continue"> {
  const s = await getSession(sessionId);
  try {
    const r = await recognize({ text, baseVersionId: s.activeVersionId, label, source: "autopilot", sessionId });
    if (r.decision === "no_match") return "continue";
    const top = r.replays.find((x) => x.antibodyId === r.blockedBy) ?? r.replays[0];
    await addEvent(sessionId, {
      key: `s${pos}-immune`,
      type: r.decision,
      label,
      text,
      recognitionId: r.recognitionId,
      antibodyId: top?.antibodyId,
      versionId: r.candidateVersionId ?? undefined,
      evidence: r.replays.map((x) => ev(x.probe, "replay")),
      runs: r.runs,
      ms: r.ms,
      msg:
        r.decision === "immune_blocked"
          ? `blocked in ${(r.ms / 1000).toFixed(1)} s: resembles ${top.antibodyId} (similarity ${top.score.toFixed(2)}) and its case failed ${top.probe.counts.targetFail}/${top.probe.trials} with this rule`
          : `resembled ${r.replays.map((x) => `${x.antibodyId} (${x.score.toFixed(2)})`).join(", ")} but passed its case; continuing to the gate`,
    });
    return r.decision === "immune_blocked" ? "immune_blocked" : "continue";
  } catch (e) {
    if (!(e instanceof NotCalibratedError)) throw e;
    await addEvent(sessionId, { key: `s${pos}-immune`, type: "immune_passed", label, text, msg: "immune check skipped: threshold not calibrated yet" });
    return "continue";
  }
}

// ---------- gate (spec 4: activate a candidate) ----------

export async function gate(
  sessionId: string,
  pos: number,
  text: string,
  label: Origin,
  trigger?: { taskId: string; runId: string },
): Promise<{ passed: boolean; versionId: string; lessonId: string }> {
  const triggerTaskId = trigger?.taskId;
  const s = await getSession(sessionId);
  const { sessions, antibodies } = await col();
  // Reuse the candidate if a retried step already made it.
  let versionId = s.candidateVersionId;
  let lessonId: string;
  if (versionId) {
    const { versions } = await col();
    lessonId = (await versions.findOne({ versionId }))!.change!.lessonId;
  } else {
    const lesson = await addLesson(text, { origin: label });
    const v = await createVersion({
      parentVersionId: s.activeVersionId,
      change: { op: "add", lessonId: lesson.lessonId },
      label,
      createdBy: "autopilot",
      status: "candidate",
      note: `${sessionId} stream item ${pos}`,
    });
    versionId = v.versionId;
    lessonId = lesson.lessonId;
    await sessions.updateOne({ sessionId }, { $set: { candidateVersionId: versionId } });
  }

  const base = { ownerId: sessionId, budgetId: sessionId, versionId, versionIndex: -1 };
  const evidence: EvidenceItem[] = [];
  const reasons: string[] = [];

  // The triggering task must now be GOOD (Confirm, 5 trials).
  if (triggerTaskId) {
    const target = (await mostFailed([trigger!.runId])) ?? "_";
    const p = await confirm({ ...base, key: `s${pos}-trigger`, phase: "gate", taskId: triggerTaskId, targetAssertion: target });
    evidence.push(ev(p, "trigger"));
    if (p.label !== "GOOD") reasons.push(`the triggering task ${triggerTaskId} is ${p.label} with the lesson`);
  }

  // Gate set and pinned set: screen (2 trials); a failure on a previously GOOD task escalates to Confirm.
  const pinned = await antibodies.find({}, { projection: { _id: 0, failingTaskId: 1, targetAssertion: 1 } }).toArray();
  const checks = [
    ...s.sets.gate.map((taskId) => ({ taskId, kind: "gate" as const, target: null as string | null })),
    ...pinned.map((a) => ({ taskId: a.failingTaskId, kind: "pinned" as const, target: a.targetAssertion })),
  ].filter((c, i, all) => all.findIndex((x) => x.taskId === c.taskId && x.kind === c.kind) === i);
  const newStatus: AutopilotSession["status0"] = {};
  for (let i = 0; i < checks.length; i += LIMITS.recheckBatch) {
    await Promise.all(
      checks.slice(i, i + LIMITS.recheckBatch).map(async (c) => {
        const sp = await screen({ ...base, key: `s${pos}-${c.kind}-${c.taskId}`, phase: "gate", taskId: c.taskId, targetAssertion: c.target ?? "_" });
        if (sp.status === "ok") {
          evidence.push(ev(sp, c.kind, "ok"));
          if (c.kind === "gate") newStatus[c.taskId] = "GOOD";
          return;
        }
        const previouslyGood = c.kind === "pinned" || s.status0[c.taskId] === "GOOD";
        if (!previouslyGood) {
          evidence.push(ev(sp, c.kind, sp.status));
          if (c.kind === "gate") newStatus[c.taskId] = "not_good";
          return;
        }
        const target = c.target ?? (await mostFailed(sp.runIds)) ?? "_";
        const cp = await confirm({ ...base, key: `s${pos}-${c.kind}-${c.taskId}-confirm`, phase: "gate", taskId: c.taskId, targetAssertion: target });
        evidence.push(ev(sp, c.kind, sp.status), ev(cp, c.kind));
        if (cp.label !== "GOOD") reasons.push(`${c.kind === "pinned" ? "pinned test" : "gate task"} ${c.taskId} is ${cp.label} (confirmed, 5 trials)`);
        else if (c.kind === "gate") newStatus[c.taskId] = "GOOD";
      }),
    );
  }

  const passed = reasons.length === 0;
  if (!passed) {
    await setVersionStatus(versionId, "rejected");
    await sessions.updateOne({ sessionId }, { $set: { candidateVersionId: null } });
  } else {
    await sessions.updateOne({ sessionId }, { $set: Object.fromEntries(Object.entries(newStatus).map(([k, v]) => [`status0.${k}`, v])) });
  }
  const runs = evidence.reduce((n, e) => n + e.trials, 0);
  await addEvent(sessionId, {
    key: `s${pos}-gate`,
    type: passed ? "gate_passed" : "gate_rejected",
    label,
    text,
    versionId,
    lessonId,
    evidence,
    runs,
    msg: passed
      ? `gate passed for ${lessonId} (${checks.length} gate/pinned tasks screened${triggerTaskId ? ", triggering task confirmed GOOD" : ""})`
      : `gate rejected ${lessonId}: ${reasons.join("; ")}`,
  });
  return { passed, versionId, lessonId };
}

export async function activate(sessionId: string, pos: number, versionId: string, label: Origin, why: string): Promise<void> {
  const s = await getSession(sessionId);
  if (s.activeVersionId === versionId) return; // retried step
  await appendVersion(s.historyId, versionId);
  await setVersionStatus(versionId, "active");
  await addEvent(
    sessionId,
    { key: `s${pos}-activated`, type: "activated", label, versionId, msg: `${versionId} is now active (${why})` },
    { activeVersionId: versionId, candidateVersionId: null, activations: s.activations + 1, position: pos + 1 },
  );
}

// Injected: added without the gate, and labelled so (spec demo branch fallback).
export async function inject(sessionId: string, pos: number, item: Extract<StreamItem, { kind: "injected" }>): Promise<void> {
  const s = await getSession(sessionId);
  const { versions } = await col();
  const existing = await versions.findOne({ note: `${sessionId} injected ${pos}` });
  const versionId =
    existing?.versionId ??
    (
      await createVersion({
        parentVersionId: s.activeVersionId,
        change: { op: "add", lessonId: (await addLesson(item.text, { origin: "injected", seedId: item.seedId })).lessonId },
        label: "injected",
        createdBy: "autopilot",
        status: "candidate",
        note: `${sessionId} injected ${pos}`,
      })
    ).versionId;
  await activate(sessionId, pos, versionId, "injected", `${item.seedId} injected: bypassed the gate`);
}

export async function advance(sessionId: string, next: number): Promise<boolean> {
  const { sessions } = await col();
  await sessions.updateOne({ sessionId, position: { $lt: next } }, { $set: { position: next } });
  const s = await getSession(sessionId);
  return s.activations - s.activationsAtLastMonitor >= MONITOR_EVERY;
}

// ---------- monitoring (spec 4: regression detected) ----------

export interface Regression {
  taskId: string;
  target: string;
}

export async function monitor(sessionId: string, key: string): Promise<Regression[]> {
  const s = await getSession(sessionId);
  const base = { ownerId: sessionId, budgetId: sessionId, versionId: s.activeVersionId, versionIndex: -1 };
  const evidence: EvidenceItem[] = [];
  const regressions: Regression[] = [];
  const falseAlarms: string[] = [];
  const unclear: string[] = [];
  const nowGood: string[] = [];
  const tasks = s.sets.monitoring;
  for (let i = 0; i < tasks.length; i += LIMITS.recheckBatch) {
    await Promise.all(
      tasks.slice(i, i + LIMITS.recheckBatch).map(async (taskId) => {
        const sp = await screen({ ...base, key: `${key}-mon-${taskId}`, phase: "monitor", taskId, targetAssertion: "_" });
        evidence.push(ev(sp, "monitor", sp.status));
        if (sp.status === "ok") {
          nowGood.push(taskId);
          return;
        }
        if (s.status0[taskId] !== "GOOD") return;
        const target = (await mostFailed(sp.runIds)) ?? "_";
        const cp = await confirm({ ...base, key: `${key}-mon-${taskId}-confirm`, phase: "monitor", taskId, targetAssertion: target });
        evidence.push(ev(cp, "monitor"));
        const d = regressionDecision(cp.label);
        if (d === "regression_confirmed") regressions.push({ taskId, target });
        else if (d === "false_alarm") falseAlarms.push(taskId);
        else unclear.push(taskId);
      }),
    );
  }
  const set: Record<string, unknown> = { activationsAtLastMonitor: s.activations };
  for (const t of nowGood) set[`status0.${t}`] = "GOOD";
  if (!regressions.length && !unclear.length) set.lastMonitorOkVersionId = s.activeVersionId;
  const runs = evidence.reduce((n, e) => n + e.trials, 0);
  const msg = regressions.length
    ? `regression on ${s.activeVersionId}: ${regressions.map((r) => `${r.taskId} breaks ${r.target}`).join("; ")} (confirmed, 5 trials)`
    : falseAlarms.length
      ? `false alarm on ${falseAlarms.join(", ")}: failed the screen but confirmed GOOD`
      : unclear.length
        ? `monitoring inconclusive on ${unclear.join(", ")}`
        : `all ${tasks.length} monitoring tasks pass on ${s.activeVersionId} (screened, 2 trials)`;
  const type = regressions.length ? "regression_confirmed" : falseAlarms.length ? "false_alarm" : unclear.length ? "insufficient_evidence" : "monitor_ok";
  await addEvent(sessionId, { key: `${key}-monitor`, type, versionId: s.activeVersionId, evidence, runs, msg, ...(regressions[0] ? { taskId: regressions[0].taskId } : {}) }, set as Partial<AutopilotSession>);
  return regressions;
}

// ---------- Bisect on a confirmed regression ----------

export async function startInvestigation(sessionId: string, key: string, reg: Regression): Promise<string> {
  const s = await getSession(sessionId);
  const { investigations } = await col();
  const existing = await investigations.findOne({ historyId: s.historyId, failureTaskId: reg.taskId, badVersionId: s.activeVersionId });
  if (existing) return existing.investigationId;
  const { createInvestigation, logInv } = await import("@/lib/bisect/investigation");
  const investigationId = await createInvestigation({
    historyId: s.historyId,
    taskId: reg.taskId,
    target: reg.target,
    goodVersionId: s.lastMonitorOkVersionId,
    badVersionId: s.activeVersionId,
    trigger: "autopilot",
  });
  const { start } = await import("workflow/api");
  const { investigate } = await import("@/workflows/investigate");
  const run = await start(investigate, [{ investigationId }]);
  await logInv(investigationId, `workflow started by autopilot ${sessionId}: ${run.runId}`, { workflowRunId: run.runId });
  await addEvent(sessionId, {
    key: `${key}-investigation`,
    type: "investigation_started",
    investigationId,
    taskId: reg.taskId,
    msg: `Bisect started itself: ${investigationId} searches ${s.lastMonitorOkVersionId}..${s.activeVersionId} for what broke ${reg.taskId}`,
  });
  return investigationId;
}

export async function investigationState(investigationId: string) {
  const { investigations } = await col();
  const inv = await investigations.findOne(
    { investigationId },
    { projection: { _id: 0, verdict: 1, acceptance: 1, antibodyId: 1, repairVersionId: 1, suspect: 1, summary: 1 } },
  );
  return inv ?? { verdict: "error" as const, acceptance: null, antibodyId: null, repairVersionId: null, suspect: null, summary: "missing" };
}

// After Bisect finishes: record the antibody, then activate the repair or wait for a person.
export async function afterInvestigation(sessionId: string, key: string, investigationId: string): Promise<"resumed" | "awaiting_decision"> {
  const inv = await investigationState(investigationId);
  if (inv.antibodyId) {
    await addEvent(sessionId, {
      key: `${key}-antibody`,
      type: "antibody_created",
      investigationId,
      antibodyId: inv.antibodyId,
      lessonId: inv.suspect?.lessonId,
      msg: `antibody ${inv.antibodyId} created from ${inv.suspect?.lessonId}: "${inv.suspect?.text}"`,
    });
  }
  if (inv.verdict === "verified" && inv.acceptance === "accepted" && inv.repairVersionId) {
    await activateRepair(sessionId, key, investigationId, inv.repairVersionId);
    return "resumed";
  }
  if (inv.verdict === "verified" && inv.repairVersionId) {
    await addEvent(
      sessionId,
      { key: `${key}-awaiting`, type: "awaiting_decision", investigationId, versionId: inv.repairVersionId, msg: `removing ${inv.suspect?.lessonId} needs a decision: ${inv.summary}` },
      { status: "awaiting_decision", pendingRepair: { investigationId, repairVersionId: inv.repairVersionId }, decision: null },
    );
    return "awaiting_decision";
  }
  await addEvent(sessionId, { key: `${key}-unresolved`, type: "insufficient_evidence", investigationId, msg: `${investigationId} ended ${inv.verdict}: ${inv.summary}; keeping ${investigationId} for a person to read` });
  return "resumed";
}

async function activateRepair(sessionId: string, key: string, investigationId: string, repairVersionId: string): Promise<void> {
  const s = await getSession(sessionId);
  if (s.activeVersionId !== repairVersionId) {
    await appendVersion(s.historyId, repairVersionId);
    await setVersionStatus(repairVersionId, "active");
  }
  await addEvent(
    sessionId,
    { key: `${key}-repair`, type: "repair_activated", investigationId, versionId: repairVersionId, msg: `repair ${repairVersionId} is active: only the convicted lesson was removed` },
    { activeVersionId: repairVersionId, lastMonitorOkVersionId: repairVersionId, status: "running", pendingRepair: null },
  );
}

export async function readDecision(sessionId: string): Promise<"approve" | "reject" | null> {
  return (await getSession(sessionId)).decision;
}

export async function applyDecision(sessionId: string, key: string, decision: "approve" | "reject"): Promise<void> {
  const s = await getSession(sessionId);
  const pending = s.pendingRepair;
  if (!pending) return;
  await addEvent(sessionId, { key: `${key}-decision`, type: "decision", investigationId: pending.investigationId, msg: decision === "approve" ? `a person approved repair ${pending.repairVersionId}` : `a person rejected repair ${pending.repairVersionId}; keeping ${s.activeVersionId}` });
  if (decision === "approve") await activateRepair(sessionId, key, pending.investigationId, pending.repairVersionId);
  else {
    const { sessions } = await col();
    await sessions.updateOne({ sessionId }, { $set: { status: "running", pendingRepair: null } });
  }
}

export async function finish(sessionId: string, status: AutopilotSession["status"], msg: string, budgetStop = false): Promise<void> {
  if (budgetStop) await addEvent(sessionId, { key: "budget-stop", type: "budget_stop", msg });
  await addEvent(sessionId, { key: "done", type: "session_done", msg }, { status, finishedAt: new Date() });
}

// Counts for the page: every run under the session's id (its own screens, confirms and replays).
export function sessionCost(sessionId: string) {
  return import("@/lib/bisect/trials").then((m) => m.costOf(sessionId));
}

