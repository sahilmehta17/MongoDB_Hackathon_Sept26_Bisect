// The Bisect investigation as a durable Vercel Workflow. The workflow function only decides what
// to test next; every piece of real work is a step whose result is saved, so a crash or redeploy
// resumes from the last finished step. No randomness, clocks or database calls in the workflow
// function itself. Decisions use the fixed evidence rules in lib/bisect/evidence.ts.
import { FatalError } from "workflow";
import { acceptRepair, verifyVerdict } from "@/lib/bisect/evidence";
import type { ContextMode, Label, Probe, RecheckRow, Verdict } from "@/lib/types";
import { LIMITS } from "@/lib/types";

type Line = { versionId: string; index: number; lessonId: string | null }[];

export async function investigate(input: { investigationId: string }) {
  "use workflow";
  const inv = input.investigationId;
  try {
    return await run(inv);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return close(inv, msg.includes("budget") ? "budget_exceeded" : "error", msg);
  }
}

async function run(inv: string): Promise<Verdict> {
  const line = await loadLine(inv);
  const last = line.length - 1;

  // 1. Pin the failure: the good endpoint must be GOOD and the bad one BAD.
  const [g0, b0] = await Promise.all([
    probe(inv, { key: "endpoint-good", phase: "endpoint", ...at(line, 0) }),
    probe(inv, { key: "endpoint-bad", phase: "endpoint", ...at(line, last) }),
  ]);
  if (g0.label !== "GOOD" || b0.label !== "BAD") {
    return close(inv, "baseline_not_reproduced", `${line[0].versionId} is ${g0.label} and ${line[last].versionId} is ${b0.label}; expected GOOD and BAD`);
  }

  // 2. Binary search for the first BAD version whose parent is GOOD (skip INCONCLUSIVE versions).
  const labels: Record<number, Label> = { 0: "GOOD", [last]: "BAD" };
  let good = 0;
  let bad = last;
  while (bad - good > 1) {
    let mid = Math.floor((good + bad) / 2);
    let label = labels[mid] ?? (labels[mid] = (await probe(inv, { key: `search-${line[mid].versionId}`, phase: "search", ...at(line, mid) })).label);
    if (label === "INCONCLUSIVE") {
      mid = nearestUntested(mid, good, bad, labels); // like `git bisect skip`
      if (mid === -1) {
        return close(inv, "inconclusive", `the first bad version is one of ${line.slice(good + 1, bad + 1).map((v) => v.versionId).join(", ")}; the rest were inconclusive`);
      }
      label = labels[mid] = (await probe(inv, { key: `search-${line[mid].versionId}`, phase: "search", ...at(line, mid) })).label;
      if (label === "INCONCLUSIVE") return close(inv, "inconclusive", "two inconclusive probes in a row");
    }
    if (label === "GOOD") good = mid;
    else bad = mid;
  }

  // 3. Verify the suspect with four fresh configurations. If the evidence contradicts the search
  //    (its parent isn't GOOD or it isn't BAD), scan up to 8 nearby versions one by one, once.
  let result = await verify(inv, line, bad, "verify");
  if (result.verdict === "inconclusive" && (result.parent !== "GOOD" || result.introducing !== "BAD")) {
    // The fresh verification results replace what the search saw for these two versions.
    labels[bad - 1] = result.parent;
    labels[bad] = result.introducing;
    const scanned = await linearScan(inv, line, bad, labels);
    if (scanned !== -1 && scanned !== bad) {
      bad = scanned;
      result = await verify(inv, line, bad, "verify2");
    }
  }
  if (result.verdict !== "verified") {
    return close(inv, "inconclusive", `four-way check mixed: parent ${result.parent}, introducing ${result.introducing}, current ${result.current}, current minus suspect ${result.currentMinusSuspect}`);
  }
  const suspect = line[bad].lessonId!;
  const current = line[last].versionId;
  // A verified conviction becomes an antibody now, whether or not the repair is later accepted.
  const antibodyId = await makeAntibody(inv, "awaiting_decision");

  // 4. Selective undo, then 5. re-check other behavior on the frozen set, 3 tasks at a time.
  const repair = await makeRepair(inv, current, suspect);
  const taskIds = await recheckSet(inv, current, suspect);
  const target = await targetOf(inv);
  const rows: RecheckRow[] = [];
  for (let i = 0; i < taskIds.length; i += LIMITS.recheckBatch) {
    const batch = taskIds.slice(i, i + LIMITS.recheckBatch);
    rows.push(...(await Promise.all(batch.map((taskId) => compare(inv, "recheck", taskId, target, current, repair)))));
  }
  // Pinned tests from antibodies (other convicted cases) must also still hold.
  const pins = await pinned(inv);
  for (let i = 0; i < pins.length; i += LIMITS.recheckBatch) {
    const batch = pins.slice(i, i + LIMITS.recheckBatch);
    rows.push(...(await Promise.all(batch.map((p) => compare(inv, "pinned", p.taskId, p.target, current, repair)))));
  }

  const failing = rows[0]; // the re-check set always starts with the failing task
  const decision = acceptRepair(
    failing.after.label,
    rows.map((r) => ({ taskId: r.taskId, before: r.before.label, after: r.after.label })),
  );
  return close(
    inv,
    "verified",
    decision.accepted
      ? `${suspect} verified and removed: failing task fixed, ${rows.length - 1} other tasks still pass`
      : `${suspect} verified; removing it needs a decision (failing task ${failing.after.label} after repair${decision.broken.length ? `; no longer GOOD: ${decision.broken.join(", ")}` : ""})`,
    { acceptance: decision.accepted ? "accepted" : "awaiting_decision", broken: decision.broken, antibodyId },
  );
}

const at = (line: Line, i: number) => ({ versionId: line[i].versionId, versionIndex: line[i].index });

function nearestUntested(mid: number, good: number, bad: number, labels: Record<number, Label>): number {
  for (let d = 1; d < bad - good; d++) {
    for (const c of [mid - d, mid + d]) if (c > good && c < bad && labels[c] === undefined) return c;
  }
  return -1;
}

async function verify(inv: string, line: Line, bad: number, tag: string) {
  const suspect = line[bad].lessonId;
  if (!suspect || bad === 0) {
    return { verdict: "inconclusive" as const, parent: "INCONCLUSIVE" as Label, introducing: "INCONCLUSIVE" as Label, current: "INCONCLUSIVE" as Label, currentMinusSuspect: "INCONCLUSIVE" as Label };
  }
  const last = line.length - 1;
  await markSuspect(inv, suspect, line[bad].versionId);
  const frozen = await freeze(inv, line[last].versionId, suspect);
  const [parent, introducing, current, minus] = await Promise.all([
    probe(inv, { key: `${tag}-parent`, phase: "verify", config: "parent", ...at(line, bad - 1) }),
    probe(inv, { key: `${tag}-introducing`, phase: "verify", config: "introducing", ...at(line, bad) }),
    probe(inv, { key: `${tag}-current`, phase: "verify", config: "current", ...at(line, last) }),
    probe(inv, {
      key: `${tag}-current_minus_suspect`,
      phase: "verify",
      config: "current_minus_suspect",
      ...at(line, last),
      contextMode: "frozen_minus_suspect",
      frozenLessonIds: frozen,
    }),
  ]);
  const four = { parent: parent.label, introducing: introducing.label, current: current.label, currentMinusSuspect: minus.label };
  return { verdict: verifyVerdict(four), ...four };
}

// Bounded linear scan: up to 8 versions around the search result, one by one, looking for the
// first BAD version whose parent is GOOD. Returns its position, or -1.
async function linearScan(inv: string, line: Line, bad: number, labels: Record<number, Label>): Promise<number> {
  const from = Math.max(1, bad - 4);
  const to = Math.min(line.length - 1, from + 7);
  const label = async (i: number): Promise<Label> =>
    labels[i] ?? (labels[i] = (await probe(inv, { key: `scan-${line[i].versionId}`, phase: "scan", ...at(line, i) })).label);
  let prev = await label(from - 1);
  for (let i = from; i <= to; i++) {
    const cur = await label(i);
    if (cur === "BAD" && prev === "GOOD") return i;
    prev = cur;
  }
  return -1;
}

// ---------------- steps (all real work happens here) ----------------

async function loadLine(inv: string): Promise<Line> {
  "use step";
  const m = await import("@/lib/bisect/investigation");
  return (await m.getInvestigation(inv)).line;
}

async function targetOf(inv: string): Promise<string> {
  "use step";
  const m = await import("@/lib/bisect/investigation");
  return (await m.getInvestigation(inv)).targetAssertion;
}

async function probe(
  inv: string,
  a: { key: string; phase: Probe["phase"]; config?: Probe["config"]; versionId: string; versionIndex: number; contextMode?: ContextMode; frozenLessonIds?: string[] },
): Promise<Probe> {
  "use step";
  const m = await import("@/lib/bisect/investigation");
  const { BudgetError } = await import("@/lib/bisect/trials");
  try {
    return await m.probeVersion(inv, a);
  } catch (e) {
    if (e instanceof BudgetError) throw new FatalError(e.message); // never retried
    throw e;
  }
}

async function markSuspect(inv: string, lessonId: string, versionId: string): Promise<void> {
  "use step";
  const m = await import("@/lib/bisect/investigation");
  await m.setSuspect(inv, lessonId, versionId);
}

async function freeze(inv: string, currentVersionId: string, suspect: string): Promise<string[]> {
  "use step";
  const m = await import("@/lib/bisect/investigation");
  return m.frozenContext(inv, currentVersionId, suspect);
}

async function makeRepair(inv: string, currentVersionId: string, suspect: string): Promise<string> {
  "use step";
  const m = await import("@/lib/bisect/investigation");
  return m.createRepair(inv, currentVersionId, suspect);
}

async function recheckSet(inv: string, currentVersionId: string, suspect: string): Promise<string[]> {
  "use step";
  const m = await import("@/lib/bisect/investigation");
  return m.recheckSet(inv, currentVersionId, suspect);
}

async function pinned(inv: string): Promise<{ taskId: string; target: string }[]> {
  "use step";
  const m = await import("@/lib/bisect/investigation");
  return m.pinnedSet(inv);
}

async function compare(inv: string, field: "recheck" | "pinned", taskId: string, target: string, beforeVersionId: string, afterVersionId: string): Promise<RecheckRow> {
  "use step";
  const m = await import("@/lib/bisect/investigation");
  const { BudgetError } = await import("@/lib/bisect/trials");
  try {
    return await m.compareTask(inv, { field, taskId, target, beforeVersionId, afterVersionId });
  } catch (e) {
    if (e instanceof BudgetError) throw new FatalError(e.message);
    throw e;
  }
}

// Every verified conviction becomes an antibody, whether or not the repair was accepted (stage 3).
async function makeAntibody(inv: string, repair: "removed" | "awaiting_decision"): Promise<string | null> {
  "use step";
  const m = await import("@/lib/immune/antibodies");
  return m.createAntibody(inv, repair);
}

async function close(inv: string, verdict: Verdict, summary: string, set: Record<string, unknown> = {}): Promise<Verdict> {
  "use step";
  const m = await import("@/lib/bisect/investigation");
  return m.closeInvestigation(inv, verdict, summary, set);
}
