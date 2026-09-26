// The re-check set: other tasks a repair must not break. Built once per investigation, then frozen,
// so the version before and after the repair are judged on the same cases. It deliberately covers
// every kind of request: yesterday a set that skipped damaged-item requests accepted a repair that
// broke them (inv25).
import { createHash } from "node:crypto";
import { col, TASK_INDEX } from "@/lib/memory/collections";
import { LIMITS } from "@/lib/types";

export interface RecheckSet {
  taskIds: string[]; // the failing task first
  reasons: Record<string, string>;
}

export async function buildRecheckSet(o: {
  ownerId: string; // investigation id: its own runs don't count as "used the lesson before"
  failingTaskId: string;
  currentVersionId: string;
  suspectLessonId: string;
  max?: number;
  perKind?: number;
}): Promise<RecheckSet> {
  const max = o.max ?? LIMITS.recheckMax;
  const perKind = o.perKind ?? 2;
  const { tasks, lessons, runs } = await col();

  const evalTasks = await tasks
    .find({ split: "eval" }, { projection: { _id: 0, taskId: 1, workflow: 1 } })
    .sort({ taskId: 1 })
    .toArray();
  const kindOf = new Map(evalTasks.map((t) => [t.taskId, t.workflow]));

  const reasons: Record<string, string> = { [o.failingTaskId]: "the failing task" };
  const full = () => Object.keys(reasons).length >= max;
  const add = (ids: string[], reason: string, limit = Infinity) => {
    let n = 0;
    for (const id of ids) {
      if (full() || n >= limit) break;
      if (id in reasons || !kindOf.has(id)) continue;
      reasons[id] = reason;
      n++;
    }
  };

  const nearest = async (vector: number[] | undefined, limit: number): Promise<string[]> => {
    if (!vector) return [];
    const hits = await tasks
      .aggregate<{ taskId: string }>([
        { $vectorSearch: { index: TASK_INDEX, path: "embedding", queryVector: vector, numCandidates: 100, limit, filter: { split: "eval" } } },
        { $project: { _id: 0, taskId: 1 } },
      ])
      .toArray();
    return hits.map((h) => h.taskId);
  };

  const escaped = o.ownerId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const [suspectDoc, failingDoc, passedOnCurrent, usedSuspect] = await Promise.all([
    lessons.findOne({ lessonId: o.suspectLessonId }, { projection: { embedding: 1 } }),
    tasks.findOne({ taskId: o.failingTaskId }, { projection: { embedding: 1 } }),
    runs.distinct("taskId", { versionId: o.currentVersionId, error: null, assertions: { $not: { $elemMatch: { passed: false } } } }),
    runs.distinct("taskId", { "retrievedLessons.id": o.suspectLessonId, runId: { $not: new RegExp(`^${escaped}-`) } }),
  ]);
  const [aboutLesson, likeFailing] = await Promise.all([nearest(suspectDoc?.embedding, 8), nearest(failingDoc?.embedding, 6)]);

  add(aboutLesson, "related to the suspect lesson (vector search)", 5);
  add(likeFailing, "similar to the failing request (vector search)", 3);
  add(roundRobin(usedSuspect.filter((id) => kindOf.has(id)), kindOf), "used the suspect lesson before", 4);

  // Coverage: at least `perKind` of every kind of request, most relevant first.
  for (const kind of [...new Set(evalTasks.map((t) => t.workflow))]) {
    const have = Object.keys(reasons).filter((id) => kindOf.get(id) === kind).length;
    const ranked = [...aboutLesson, ...usedSuspect, ...likeFailing, ...passedOnCurrent, ...evalTasks.map((t) => t.taskId)].filter(
      (id, i, all) => kindOf.get(id) === kind && all.indexOf(id) === i,
    );
    add(ranked, "coverage: every kind of request", Math.max(0, perKind - have));
  }

  // Controls: a reproducible "random" pick, so re-running an investigation picks the same ones.
  const byHash = evalTasks
    .map((t) => t.taskId)
    .filter((id) => !(id in reasons))
    .sort((a, b) => hash(o.ownerId + a).localeCompare(hash(o.ownerId + b)));
  add(byHash, "control (unrelated task)", 2);
  add(passedOnCurrent, "passed on the current version");

  return { taskIds: Object.keys(reasons), reasons };
}

const hash = (s: string) => createHash("sha256").update(s).digest("hex");

function roundRobin(ids: string[], kindOf: Map<string, string>): string[] {
  const byKind = new Map<string, string[]>();
  for (const id of ids) byKind.set(kindOf.get(id)!, [...(byKind.get(kindOf.get(id)!) ?? []), id]);
  const out: string[] = [];
  for (let i = 0; out.length < ids.length; i++) byKind.forEach((list) => list[i] && out.push(list[i]));
  return out;
}
