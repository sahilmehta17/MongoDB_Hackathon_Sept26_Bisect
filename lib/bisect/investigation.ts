// The work behind each step of workflows/investigate.ts. Everything here touches the database or
// runs trials, and is safe to repeat: workflow steps are retried when they throw.
import { buildRecheckSet } from "@/lib/bisect/recheck";
import { confirm, costOf, openBudget } from "@/lib/bisect/trials";
import { getAgentConfig, getTask } from "@/lib/data";
import { col } from "@/lib/memory/collections";
import { getHistory } from "@/lib/memory/histories";
import { createVersion, getLessons } from "@/lib/memory/lessons";
import { getRunsByIds } from "@/lib/memory/runs";
import type { ContextMode, Investigation, InvestigationView, Probe, RecheckRow, Verdict } from "@/lib/types";
import { LIMITS } from "@/lib/types";

export class InputError extends Error {}

export type LinePoint = Investigation["line"][number];

export async function createInvestigation(input: {
  historyId: string;
  taskId: string;
  target: string;
  goodVersionId?: string;
  badVersionId?: string;
  trigger?: Investigation["trigger"];
  sessionId?: string;
}): Promise<string> {
  const history = await getHistory(input.historyId).catch(() => null);
  if (!history) throw new InputError(`history ${input.historyId} not found`);
  const task = await getTask(input.taskId).catch(() => null);
  if (!task) throw new InputError(`task ${input.taskId} not found`);
  if (input.target !== "within_step_limit" && !task.checks.some((c) => c.name === input.target)) {
    throw new InputError(`task ${input.taskId} has no check named ${input.target}`);
  }
  const ids = history.versionIds;
  const pos = (id: string | undefined, fallback: number) => {
    if (!id) return fallback;
    const i = ids.indexOf(id);
    if (i === -1) throw new InputError(`version ${id} is not on history ${input.historyId}`);
    return i;
  };
  const g = pos(input.goodVersionId, 0);
  const b = pos(input.badVersionId, ids.length - 1);
  if (b <= g) throw new InputError("the bad version must come after the good version");

  const { versions, investigations } = await col();
  const docs = await versions.find({ versionId: { $in: ids.slice(g, b + 1) } }, { projection: { _id: 0 } }).toArray();
  const byId = new Map(docs.map((v) => [v.versionId, v]));
  const line: LinePoint[] = ids.slice(g, b + 1).map((id) => {
    const v = byId.get(id)!;
    return { versionId: id, index: v.index, lessonId: v.change?.op === "add" ? v.change.lessonId : null };
  });

  const { nextId } = await import("@/lib/memory/collections");
  const investigationId = await nextId("inv");
  await openBudget(investigationId, { maxRuns: LIMITS.maxRuns, maxModelCalls: LIMITS.maxModelCalls });
  const doc: Investigation = {
    investigationId,
    historyId: input.historyId,
    trigger: input.trigger ?? "manual",
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    failureTaskId: input.taskId,
    targetAssertion: input.target,
    goodVersionId: line[0].versionId,
    badVersionId: line[line.length - 1].versionId,
    line,
    probes: [],
    suspect: null,
    verification: [],
    repairVersionId: null,
    recheck: [],
    pinned: [],
    acceptance: null,
    broken: [],
    antibodyId: null,
    verdict: "running",
    startedAt: new Date(),
    log: [
      {
        at: new Date(),
        msg: `opened: ${input.taskId} / ${input.target} on ${input.historyId}, searching ${line.length} versions ${line[0].versionId} (expected GOOD) .. ${line[line.length - 1].versionId} (expected BAD)`,
      },
    ],
  };
  await investigations.insertOne(doc);
  return investigationId;
}

export async function getInvestigation(investigationId: string): Promise<Investigation> {
  const { investigations } = await col();
  const inv = await investigations.findOne({ investigationId }, { projection: { _id: 0 } });
  if (!inv) throw new Error(`investigation ${investigationId} not found`);
  return inv as Investigation;
}

export async function logInv(investigationId: string, msg: string, set: Partial<Investigation> = {}): Promise<void> {
  const { investigations } = await col();
  await investigations.updateOne({ investigationId }, { $set: set, $push: { log: { at: new Date(), msg } } });
}

// Replace-or-append by key in one atomic update, so a retried step never duplicates an entry.
async function upsertByKey(investigationId: string, field: "probes" | "verification", probe: Probe): Promise<void> {
  const { investigations } = await col();
  await investigations.updateOne({ investigationId }, [
    {
      $set: {
        [field]: {
          $concatArrays: [{ $filter: { input: { $ifNull: [`$${field}`, []] }, cond: { $ne: ["$$this.key", probe.key] } } }, [probe]],
        },
      },
    },
  ]);
}

async function upsertRow(investigationId: string, field: "recheck" | "pinned", row: RecheckRow): Promise<void> {
  const { investigations } = await col();
  await investigations.updateOne({ investigationId }, [
    {
      $set: {
        [field]: {
          $concatArrays: [{ $filter: { input: { $ifNull: [`$${field}`, []] }, cond: { $ne: ["$$this.taskId", row.taskId] } } }, [row]],
        },
      },
    },
  ]);
}

const describe = (p: Probe) =>
  `${p.label} (${p.counts.targetFail}/${p.trials} target fail, ${p.counts.pass} pass, ${p.counts.otherFail} other, ${p.counts.error} error)`;

// 5 fresh trials of the failing task on one version or configuration.
export async function probeVersion(
  investigationId: string,
  a: {
    key: string;
    phase: Probe["phase"];
    config?: Probe["config"];
    versionId: string;
    versionIndex: number;
    contextMode?: ContextMode;
    frozenLessonIds?: string[];
  },
): Promise<Probe> {
  const inv = await getInvestigation(investigationId);
  const probe = await confirm({
    ...a,
    ownerId: investigationId,
    budgetId: investigationId,
    taskId: inv.failureTaskId,
    targetAssertion: inv.targetAssertion,
  });
  await upsertByKey(investigationId, a.phase === "verify" ? "verification" : "probes", probe);
  await logInv(investigationId, `${a.phase} ${a.config ?? a.versionId}: ${describe(probe)}`);
  return probe;
}

export async function setSuspect(investigationId: string, lessonId: string, versionId: string): Promise<void> {
  const [lesson] = await getLessons([lessonId]);
  await logInv(investigationId, `suspect: ${lessonId} (added in ${versionId}) "${lesson.text}"`, {
    suspect: { lessonId, versionId, text: lesson.text, origin: lesson.origin },
  });
}

// The lessons the current version actually showed the agent on the failing task (the most common
// set across its endpoint runs), minus the suspect: the "without the lesson" configuration.
export async function frozenContext(investigationId: string, currentVersionId: string, suspect: string): Promise<string[]> {
  const inv = await getInvestigation(investigationId);
  const endpoint = inv.probes.find((p) => p.phase === "endpoint" && p.versionId === currentVersionId);
  const runs = endpoint ? await getRunsByIds(endpoint.runIds) : [];
  const tally = new Map<string, number>();
  for (const r of runs.filter((r) => !r.error)) {
    const k = [...new Set(r.retrievedLessons.map((l) => l.id))].sort().join(",");
    tally.set(k, (tally.get(k) ?? 0) + 1);
  }
  const top = [...tally.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
  const seen = top ? top.split(",").filter(Boolean) : [];
  await logInv(
    investigationId,
    seen.includes(suspect)
      ? `without the suspect: the agent's own lessons for this task (${seen.join(", ")}) minus ${suspect}, nothing added in its place`
      : `note: ${suspect} was not among the lessons the current version showed (${seen.join(", ") || "none"})`,
  );
  return seen.filter((id) => id !== suspect);
}

// Selective undo: the current version minus only the suspect, as a candidate.
export async function createRepair(investigationId: string, currentVersionId: string, suspect: string): Promise<string> {
  const { versions, lessons } = await col();
  const existing = await versions.findOne({ investigationId, createdBy: "bisect", "change.op": "remove" });
  if (existing) return existing.versionId; // retried step
  const inv = await getInvestigation(investigationId);
  const repair = await createVersion({
    parentVersionId: currentVersionId,
    change: { op: "remove", lessonId: suspect },
    label: inv.suspect?.origin,
    createdBy: "bisect",
    status: "candidate",
    investigationId,
    note: `selective undo of ${suspect} by ${investigationId}`,
  });
  const children = await lessons.find({ parentLessonIds: suspect }, { projection: { lessonId: 1 } }).toArray();
  await logInv(
    investigationId,
    `repair candidate ${repair.versionId} = ${currentVersionId} minus ${suspect}` +
      (children.length ? `; learned from the removed lesson: ${children.map((c) => c.lessonId).join(", ")}` : ""),
    { repairVersionId: repair.versionId },
  );
  return repair.versionId;
}

export async function recheckSet(investigationId: string, currentVersionId: string, suspect: string): Promise<string[]> {
  const inv = await getInvestigation(investigationId);
  if (inv.recheckTaskIds) return inv.recheckTaskIds; // frozen
  const set = await buildRecheckSet({
    ownerId: investigationId,
    failingTaskId: inv.failureTaskId,
    currentVersionId,
    suspectLessonId: suspect,
  });
  const byReason = Object.values(set.reasons).reduce<Record<string, number>>((a, r) => ((a[r] = (a[r] ?? 0) + 1), a), {});
  await logInv(
    investigationId,
    `re-check set frozen: ${set.taskIds.length} tasks (${Object.entries(byReason).map(([r, n]) => `${n} ${r}`).join("; ")})`,
    { recheckTaskIds: set.taskIds, recheckReasons: set.reasons },
  );
  return set.taskIds;
}

// Pinned tests from antibodies (stage 3): every repair must also pass these.
export async function pinnedSet(investigationId: string): Promise<{ taskId: string; target: string }[]> {
  const inv = await getInvestigation(investigationId);
  const { antibodies } = await col();
  const { scopeOf } = await import("@/lib/immune/antibodies");
  const list = await antibodies.find({ scope: scopeOf(inv) }, { projection: { _id: 0, failingTaskId: 1, targetAssertion: 1 } }).toArray();
  const seen = new Set<string>([inv.failureTaskId]);
  return list
    .filter((a) => !seen.has(a.failingTaskId) && seen.add(a.failingTaskId))
    .map((a) => ({ taskId: a.failingTaskId, target: a.targetAssertion }));
}

// One task, before (current version) vs after (the repair), normal retrieval, fresh trials.
export async function compareTask(
  investigationId: string,
  o: { field: "recheck" | "pinned"; taskId: string; target: string; beforeVersionId: string; afterVersionId: string },
): Promise<RecheckRow> {
  const inv = await getInvestigation(investigationId);
  const common = { ownerId: investigationId, budgetId: investigationId, taskId: o.taskId, targetAssertion: o.target, versionIndex: -1 };
  const [before, after] = await Promise.all([
    confirm({ ...common, key: `${o.field}-before-${o.taskId}`, phase: o.field, config: "before", versionId: o.beforeVersionId }),
    confirm({ ...common, key: `${o.field}-after-${o.taskId}`, phase: o.field, config: "after", versionId: o.afterVersionId }),
  ]);
  const reason = o.field === "pinned" ? "pinned test from an antibody" : (inv.recheckReasons?.[o.taskId] ?? "");
  const row: RecheckRow = { taskId: o.taskId, reason, before, after };
  await upsertRow(investigationId, o.field, row);
  return row;
}

export async function closeInvestigation(
  investigationId: string,
  verdict: Verdict,
  summary: string,
  set: Partial<Investigation> = {},
): Promise<Verdict> {
  const inv = await getInvestigation(investigationId);
  if (inv.verdict !== "running") return inv.verdict; // retried step: already closed
  await logInv(investigationId, `verdict: ${verdict}: ${summary}`, { ...set, verdict, summary, finishedAt: new Date() });
  if (set.acceptance === "accepted" && inv.repairVersionId) {
    const { versions } = await col();
    await versions.updateOne({ versionId: inv.repairVersionId }, { $set: { status: "active" } });
    const antibodyId = (set.antibodyId as string | undefined) ?? inv.antibodyId;
    if (antibodyId) await (await import("@/lib/immune/antibodies")).markRepaired(antibodyId);
  }
  return verdict;
}

// Everything the results page needs, in one response.
export async function investigationView(investigationId: string): Promise<InvestigationView> {
  const investigation = await getInvestigation(investigationId);
  const lessonIds = [
    ...new Set([...investigation.line.map((p) => p.lessonId).filter((x): x is string => !!x), ...(investigation.suspect ? [investigation.suspect.lessonId] : [])]),
  ];
  const taskIds = [
    ...new Set([investigation.failureTaskId, ...(investigation.recheckTaskIds ?? []), ...investigation.pinned.map((r) => r.taskId)]),
  ];
  const [cost, lessonDocs, cfg, history, taskDocs] = await Promise.all([
    costOf(investigationId),
    getLessons(lessonIds),
    getAgentConfig(),
    getHistory(investigation.historyId).catch(() => null),
    Promise.all(taskIds.map((id) => getTask(id).catch(() => null))),
  ]);
  const end = investigation.finishedAt ? new Date(investigation.finishedAt).getTime() : Date.now();
  return {
    investigation,
    cost,
    elapsedMs: end - new Date(investigation.startedAt).getTime(),
    lessons: Object.fromEntries(lessonDocs.map((l) => [l.lessonId, { text: l.text, origin: l.origin, seedId: l.seedId }])),
    tasks: Object.fromEntries(taskDocs.filter((t) => t !== null).map((t) => [t.taskId, { request: t.request, workflow: t.workflow }])),
    houseRules: cfg.houseRules,
    groundTruth: history?.groundTruth ?? null,
  };
}
