// Autopilot as a durable Vercel Workflow (spec section 7):
//   next training request → run on the active version → failed? → propose one lesson
//   → immune check → blocked? stop → gate → activate or reject
//   → every 3 activations: screen the monitoring set → confirm → BAD → Bisect (its own workflow)
//   → verified → antibody → repair → accepted: activate and resume / otherwise wait for a person.
// The workflow function only sequences steps; every piece of real work is a step, so a crash or
// redeploy resumes where it stopped. Waiting uses the workflow's durable sleep.
import { FatalError, sleep } from "workflow";
import type { AutopilotSession, Origin, StreamItem } from "@/lib/types";

export async function autopilot(input: { sessionId: string }) {
  "use workflow";
  const sid = input.sessionId;
  try {
    await loop(sid);
    await finish(sid, "done", "stream finished");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const budget = msg.includes("budget");
    await finish(sid, budget ? "stopped" : "error", budget ? `stopped: ${msg}` : `error: ${msg}`, budget);
  }
}

async function loop(sid: string): Promise<void> {
  const { stream, position } = await load(sid);
  await baseline(sid);
  for (let pos = position; pos < stream.length; pos++) {
    const item = stream[pos];
    if (item.kind === "training") {
      const run = await trainingRun(sid, pos, item.taskId);
      if (!run.passed) {
        const rule = await propose(sid, pos, run.runId, item.taskId);
        if (rule) await consider(sid, pos, rule, "natural", { taskId: item.taskId, runId: run.runId });
      }
    } else if (item.kind === "planted" || item.kind === "reworded") {
      await announce(sid, pos, item, "planted");
      await consider(sid, pos, item.text, "planted");
    } else if (item.kind === "injected") {
      await announce(sid, pos, item, "injected");
      await inject(sid, pos, item);
    } else {
      await monitorAndRepair(sid, `s${pos}`);
    }
    if (await advance(sid, pos + 1)) await monitorAndRepair(sid, `s${pos}-auto`);
  }
}

// A proposed lesson: the immune check first, then the gate.
async function consider(sid: string, pos: number, text: string, label: Origin, trigger?: { taskId: string; runId: string }) {
  if ((await immune(sid, pos, text, label)) === "immune_blocked") return;
  const g = await gate(sid, pos, text, label, trigger);
  if (g.passed) await activate(sid, pos, g.versionId, label);
}

async function monitorAndRepair(sid: string, key: string) {
  const regressions = await monitor(sid, key);
  if (!regressions.length) return;
  const inv = await startInvestigation(sid, key, regressions[0]);
  while ((await investigationVerdict(inv)) === "running") await sleep("10s");
  if ((await afterInvestigation(sid, key, inv)) === "awaiting_decision") {
    let decision = await readDecision(sid);
    while (!decision) {
      await sleep("10s");
      decision = await readDecision(sid);
    }
    await applyDecision(sid, key, decision);
  }
}

// ---------------- steps ----------------

const steps = () => import("@/lib/autopilot/steps");

async function guard<T>(fn: () => Promise<T>): Promise<T> {
  const { BudgetError } = await import("@/lib/bisect/trials");
  try {
    return await fn();
  } catch (e) {
    if (e instanceof BudgetError) throw new FatalError(e.message); // never retried
    throw e;
  }
}

async function load(sid: string): Promise<Pick<AutopilotSession, "stream" | "position">> {
  "use step";
  const s = await (await steps()).getSession(sid);
  return { stream: s.stream, position: s.position };
}

async function baseline(sid: string): Promise<void> {
  "use step";
  const m = await steps();
  await guard(() => m.establishBaseline(sid));
}

async function trainingRun(sid: string, pos: number, taskId: string): Promise<{ passed: boolean; runId: string }> {
  "use step";
  const m = await steps();
  return guard(() => m.trainingRun(sid, pos, taskId));
}

async function propose(sid: string, pos: number, runId: string, taskId: string): Promise<string | null> {
  "use step";
  return (await (await steps()).propose(sid, pos, runId, taskId)).rule;
}

async function announce(sid: string, pos: number, item: Extract<StreamItem, { text: string }>, label: Origin): Promise<void> {
  "use step";
  await (await steps()).announce(sid, pos, item, label);
}

async function immune(sid: string, pos: number, text: string, label: Origin): Promise<"immune_blocked" | "continue"> {
  "use step";
  const m = await steps();
  return guard(() => m.immuneCheck(sid, pos, text, label));
}

async function gate(sid: string, pos: number, text: string, label: Origin, trigger?: { taskId: string; runId: string }) {
  "use step";
  const m = await steps();
  return guard(() => m.gate(sid, pos, text, label, trigger));
}

async function activate(sid: string, pos: number, versionId: string, label: Origin): Promise<void> {
  "use step";
  await (await steps()).activate(sid, pos, versionId, label, "passed the gate");
}

async function inject(sid: string, pos: number, item: Extract<StreamItem, { kind: "injected" }>): Promise<void> {
  "use step";
  await (await steps()).inject(sid, pos, item);
}

async function advance(sid: string, next: number): Promise<boolean> {
  "use step";
  return (await steps()).advance(sid, next);
}

async function monitor(sid: string, key: string) {
  "use step";
  const m = await steps();
  return guard(() => m.monitor(sid, key));
}

async function startInvestigation(sid: string, key: string, reg: { taskId: string; target: string }): Promise<string> {
  "use step";
  return (await steps()).startInvestigation(sid, key, reg);
}

async function investigationVerdict(investigationId: string): Promise<string> {
  "use step";
  return (await (await steps()).investigationState(investigationId)).verdict;
}

async function afterInvestigation(sid: string, key: string, investigationId: string): Promise<"resumed" | "awaiting_decision"> {
  "use step";
  return (await steps()).afterInvestigation(sid, key, investigationId);
}

async function readDecision(sid: string): Promise<"approve" | "reject" | null> {
  "use step";
  return (await steps()).readDecision(sid);
}

async function applyDecision(sid: string, key: string, decision: "approve" | "reject"): Promise<void> {
  "use step";
  await (await steps()).applyDecision(sid, key, decision);
}

async function finish(sid: string, status: AutopilotSession["status"], msg: string, budgetStop = false): Promise<void> {
  "use step";
  await (await steps()).finish(sid, status, msg, budgetStop);
}
