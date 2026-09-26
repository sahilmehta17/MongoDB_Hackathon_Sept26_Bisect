// The evidence rules (spec section 4), as pure functions. Fixed before any run; never tuned to
// make a demo pass. Every decision in the app goes through these.
import type { Counts, Label, Outcome, RunRecord } from "@/lib/types";

// One run's outcome for a target assertion. Other failures are shown but never count toward BAD.
export function outcomeOf(run: Pick<RunRecord, "error" | "assertions">, target: string): Outcome {
  if (run.error) return "error";
  if (run.assertions.every((a) => a.passed)) return "pass";
  if (run.assertions.some((a) => a.name === target && !a.passed)) return "target_fail";
  return "other_fail";
}

export function countOutcomes(runs: Pick<RunRecord, "error" | "assertions">[], target: string): Counts {
  const c: Counts = { pass: 0, targetFail: 0, otherFail: 0, error: 0 };
  for (const r of runs) {
    const o = outcomeOf(r, target);
    if (o === "pass") c.pass++;
    else if (o === "target_fail") c.targetFail++;
    else if (o === "other_fail") c.otherFail++;
    else c.error++;
  }
  return c;
}

// Confirm (5 trials): all pass every assertion → GOOD; 3+ fail the target → BAD; more than 2 infra
// errors → INCONCLUSIVE; anything else → INCONCLUSIVE.
export function classify(c: Counts, trials = 5): Label {
  if (c.error > 2) return "INCONCLUSIVE";
  if (c.pass === trials) return "GOOD";
  if (c.targetFail >= 3) return "BAD";
  return "INCONCLUSIVE";
}

// Screen (2 trials): both pass → ok. Any failure → fail (a previously GOOD task then escalates to
// Confirm). An infra error that survived its reruns → insufficient_evidence, which counts as not OK.
export type ScreenStatus = "ok" | "fail" | "insufficient_evidence";
export function screenStatus(c: Counts, trials = 2): ScreenStatus {
  if (c.error > 0) return "insufficient_evidence";
  return c.pass === trials ? "ok" : "fail";
}

// Verify a suspect: parent GOOD, introducing version BAD, current BAD, current minus the suspect
// (frozen retrieval, no backfill) GOOD → verified; anything else → inconclusive.
export interface FourWay {
  parent: Label;
  introducing: Label;
  current: Label;
  currentMinusSuspect: Label;
}
export function verifyVerdict(v: FourWay): "verified" | "inconclusive" {
  return v.parent === "GOOD" && v.introducing === "BAD" && v.current === "BAD" && v.currentMinusSuspect === "GOOD"
    ? "verified"
    : "inconclusive";
}

// Accept a repair: the failing task GOOD on the repair, and every task that was GOOD before is
// still GOOD → activate; otherwise a person decides.
export interface RecheckPair {
  taskId: string;
  before: Label;
  after: Label;
}
export function acceptRepair(failingAfter: Label, rows: RecheckPair[]): { accepted: boolean; broken: string[] } {
  const broken = rows.filter((r) => r.before === "GOOD" && r.after !== "GOOD").map((r) => r.taskId);
  return { accepted: failingAfter === "GOOD" && broken.length === 0, broken };
}

// Immune block: only a failed replay blocks (Confirm BAD on the antibody's case). GOOD or
// INCONCLUSIVE continues to the normal gate: never block on weak evidence.
export function immuneDecision(replay: Label): "immune_blocked" | "immune_passed" {
  return replay === "BAD" ? "immune_blocked" : "immune_passed";
}

// Regression detected (autopilot): monitoring screened not-OK, then Confirm decides.
export function regressionDecision(confirm: Label): "regression_confirmed" | "false_alarm" | "inconclusive" {
  if (confirm === "BAD") return "regression_confirmed";
  if (confirm === "GOOD") return "false_alarm";
  return "inconclusive";
}

// Which assertion to confirm a screen failure on: the one that failed most often; ties go to the
// task's own check order (so a double refund confirms on the task's first failing check).
export function pickTarget(runs: Pick<RunRecord, "assertions">[], checkOrder: string[]): string | null {
  const n = new Map<string, number>();
  for (const r of runs) for (const a of r.assertions) if (!a.passed) n.set(a.name, (n.get(a.name) ?? 0) + 1);
  const rank = (name: string) => {
    const i = checkOrder.indexOf(name);
    return i === -1 ? checkOrder.length : i;
  };
  return [...n.entries()].sort((a, b) => b[1] - a[1] || rank(a[0]) - rank(b[0]))[0]?.[0] ?? null;
}
