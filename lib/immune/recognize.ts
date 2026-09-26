// Recognition (spec 6.3): runs first for any proposed lesson.
// 1. Embed the proposed text; Vector Search the antibodies, top 3 at or above the threshold.
// 2. No match → "no_match" (the normal gate decides).
// 3. Match → replay that antibody's failing case on the candidate (base version + the proposed
//    lesson): Confirm, 5 fresh trials, on its target assertion. Top match first; if it isn't BAD,
//    try the next.
// 4. BAD → immune_blocked. 5. Otherwise → immune_passed ("resembled abN but passed its case").
// Similarity only chooses which case to replay; a false match costs 5 runs, never a wrong block.
import { immuneDecision } from "@/lib/bisect/evidence";
import { confirm, costOf, openBudget } from "@/lib/bisect/trials";
import { ANTIBODY_INDEX, col, nextId } from "@/lib/memory/collections";
import { addLesson, createVersion, queryVector } from "@/lib/memory/lessons";
import { IMMUNE_THRESHOLD, IMMUNE_TOP_K } from "@/lib/immune/threshold";
import type { Origin, Recognition } from "@/lib/types";
import { LIMITS } from "@/lib/types";

export class NotCalibratedError extends Error {}

export interface AntibodyMatch {
  antibodyId: string;
  score: number;
  lessonText: string;
  failingTaskId: string;
  targetAssertion: string;
}

// Antibodies most similar to a text (Atlas score, (1 + cosine) / 2), best first. No threshold.
export async function similarAntibodies(text: string, k = IMMUNE_TOP_K): Promise<AntibodyMatch[]> {
  const { antibodies } = await col();
  if ((await antibodies.estimatedDocumentCount()) === 0) return [];
  const hits = await antibodies
    .aggregate<AntibodyMatch>([
      { $vectorSearch: { index: ANTIBODY_INDEX, path: "embedding", queryVector: await queryVector(text), numCandidates: 100, limit: k } },
      {
        $project: {
          _id: 0,
          antibodyId: 1,
          lessonText: 1,
          failingTaskId: 1,
          targetAssertion: 1,
          score: { $meta: "vectorSearchScore" },
        },
      },
    ])
    .toArray();
  return hits.sort((a, b) => b.score - a.score || a.antibodyId.localeCompare(b.antibodyId));
}

export async function recognize(o: {
  text: string;
  baseVersionId: string;
  label: Origin;
  source: Recognition["source"];
  sessionId?: string;
  threshold?: number; // only scripts may override (calibration); the app always uses IMMUNE_THRESHOLD
}): Promise<Recognition> {
  const threshold = o.threshold ?? IMMUNE_THRESHOLD;
  if (threshold === null) throw new NotCalibratedError("the immune threshold hasn't been calibrated yet");
  const t0 = Date.now();
  const { recognitions, antibodies } = await col();
  const recognitionId = await nextId("rec");
  const matches = (await similarAntibodies(o.text)).filter((m) => m.score >= threshold);

  const rec: Recognition = {
    recognitionId,
    text: o.text,
    label: o.label,
    source: o.source,
    ...(o.sessionId ? { sessionId: o.sessionId } : {}),
    baseVersionId: o.baseVersionId,
    candidateVersionId: null,
    lessonId: null,
    threshold,
    matches: matches.map(({ antibodyId, score, lessonText }) => ({ antibodyId, score, lessonText })),
    replays: [],
    decision: "no_match",
    blockedBy: null,
    ms: 0,
    runs: 0,
    createdAt: new Date(),
  };

  if (matches.length) {
    const lesson = await addLesson(o.text, { origin: o.label });
    const candidate = await createVersion({
      parentVersionId: o.baseVersionId,
      change: { op: "add", lessonId: lesson.lessonId },
      label: o.label,
      createdBy: "immune",
      status: "candidate",
      note: `candidate for recognition ${recognitionId}`,
    });
    rec.lessonId = lesson.lessonId;
    rec.candidateVersionId = candidate.versionId;
    await openBudget(recognitionId, { maxRuns: IMMUNE_TOP_K * LIMITS.confirmTrials });

    for (const m of matches) {
      const probe = await confirm({
        key: `replay-${m.antibodyId}`,
        ownerId: recognitionId,
        budgetId: recognitionId,
        phase: "replay",
        taskId: m.failingTaskId,
        versionId: candidate.versionId,
        versionIndex: -1,
        targetAssertion: m.targetAssertion,
      });
      rec.replays.push({ antibodyId: m.antibodyId, score: m.score, probe });
      const blocked = immuneDecision(probe.label) === "immune_blocked";
      await antibodies.updateOne({ antibodyId: m.antibodyId }, { $inc: { recognitions: 1, ...(blocked ? { blocks: 1 } : {}) } });
      if (blocked) {
        rec.blockedBy = m.antibodyId;
        break;
      }
    }
    rec.decision = rec.blockedBy ? "immune_blocked" : "immune_passed";
    rec.runs = (await costOf(recognitionId)).runs;
  }
  rec.ms = Date.now() - t0;
  await recognitions.insertOne({ ...rec });
  return rec;
}

// Antibodies are searchable a moment after insert (Atlas Search is eventually consistent).
export async function waitAntibodySearchable(antibodyId: string, embedding: number[], maxMs = 60_000): Promise<void> {
  const { antibodies } = await col();
  const t0 = Date.now();
  for (let delay = 200; ; delay = Math.min(delay * 2, 1000)) {
    const hits = await antibodies
      .aggregate([
        { $vectorSearch: { index: ANTIBODY_INDEX, path: "embedding", queryVector: embedding, numCandidates: 10, limit: 1, filter: { antibodyId: { $eq: antibodyId } } } },
        { $project: { _id: 0, antibodyId: 1 } },
      ])
      .toArray();
    if (hits.length) return;
    if (Date.now() - t0 > maxMs) throw new Error(`antibody ${antibodyId} not searchable after ${maxMs / 1000}s`);
    await new Promise((r) => setTimeout(r, delay));
  }
}
