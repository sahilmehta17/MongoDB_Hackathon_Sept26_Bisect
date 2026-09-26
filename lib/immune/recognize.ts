// Recognition (spec 6.3): runs first for any proposed lesson.
// 1. Embed the proposed text; Vector Search the antibodies, top 3 at or above the threshold.
// 2. No match → "no_match" (the normal gate decides).
// 3. Match → replay that antibody's failing case on the candidate (base version + the proposed
//    lesson): Confirm, 5 fresh trials, on its target assertion. Top match first; if it isn't BAD,
//    try the next.
// 4. BAD → immune_blocked. 5. Otherwise → immune_passed ("resembled abN but passed its case").
// Similarity only chooses which case to replay; a false match costs 5 runs, never a wrong block.
// Team decision: a block must mean the proposed rule caused the failure, so a case is replayed only
// if the base agent passes it (from earlier runs on the base, or one Confirm cached for next time).
import { classify, countOutcomes, immuneDecision } from "@/lib/bisect/evidence";
import { confirm, costOf, openBudget } from "@/lib/bisect/trials";
import { IMMUNE_THRESHOLD, IMMUNE_TOP_K } from "@/lib/immune/threshold";
import { ANTIBODY_INDEX, col, nextId } from "@/lib/memory/collections";
import { addLesson, createVersion, queryVector } from "@/lib/memory/lessons";
import type { Label, Origin, Recognition, Version } from "@/lib/types";
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
// `scope` limits the search to one memory (an autopilot session); null searches every antibody.
export async function similarAntibodies(text: string, k = IMMUNE_TOP_K, scope: string | null = null): Promise<AntibodyMatch[]> {
  const { antibodies } = await col();
  if ((await antibodies.countDocuments(scope ? { scope } : {})) === 0) return [];
  const hits = await antibodies
    .aggregate<AntibodyMatch>([
      {
        $vectorSearch: {
          index: ANTIBODY_INDEX,
          path: "embedding",
          queryVector: await queryVector(text),
          numCandidates: 100,
          limit: k,
          ...(scope ? { filter: { scope: { $eq: scope } } } : {}),
        },
      },
      { $project: { _id: 0, antibodyId: 1, lessonText: 1, failingTaskId: 1, targetAssertion: 1, createdAt: 1, score: { $meta: "vectorSearchScore" } } },
    ])
    .toArray();
  // Best first. The same rule convicted in several memories scores the same up to embedding noise
  // (~0.001), so scores are compared at 2 decimals and ties go to the newest conviction.
  const r2 = (x: number) => Math.round(x * 100);
  const at = (m: AntibodyMatch & { createdAt?: Date }) => new Date(m.createdAt ?? 0).getTime();
  return hits
    .sort((a, b) => r2(b.score) - r2(a.score) || at(b) - at(a) || a.antibodyId.localeCompare(b.antibodyId))
    .map(({ antibodyId, lessonText, failingTaskId, targetAssertion, score }) => ({ antibodyId, lessonText, failingTaskId, targetAssertion, score }));
}

// Does the base agent pass this case? Uses the latest 5 normal runs already saved on the base, or
// runs one Confirm (fixed runIds, so it's paid once and reused).
export async function baseCaseLabel(baseVersionId: string, taskId: string, target: string): Promise<{ label: Label; ranRuns: number }> {
  const { runs } = await col();
  const saved = await runs
    .find({ versionId: baseVersionId, taskId, contextMode: "normal", error: null }, { projection: { _id: 0, assertions: 1, error: 1 } })
    .sort({ createdAt: -1 })
    .limit(LIMITS.confirmTrials)
    .toArray();
  if (saved.length === LIMITS.confirmTrials) return { label: classify(countOutcomes(saved, target)), ranRuns: 0 };
  const owner = `base-${baseVersionId}`;
  await openBudget(owner, { maxRuns: 200 });
  const p = await confirm({ key: taskId, ownerId: owner, budgetId: owner, phase: "replay", taskId, versionId: baseVersionId, versionIndex: -1, targetAssertion: target });
  return { label: p.label, ranRuns: p.trials };
}

export async function recognize(o: {
  text: string;
  baseVersionId: string;
  label: Origin;
  source: Recognition["source"];
  sessionId?: string; // autopilot: only this session's antibodies, and a stable id so a retry is free
  threshold?: number; // only scripts may override; the app always uses IMMUNE_THRESHOLD
}): Promise<Recognition> {
  const threshold = o.threshold ?? IMMUNE_THRESHOLD;
  if (threshold === null) throw new NotCalibratedError("the immune threshold hasn't been calibrated yet");
  const { recognitions, antibodies, versions } = await col();
  const recognitionId = o.sessionId ? `rec-${o.sessionId}-${createHashShort(o.text + o.baseVersionId)}` : await nextId("rec");
  const done = await recognitions.findOne({ recognitionId }, { projection: { _id: 0 } });
  if (done) return done as Recognition; // retried step: already decided and counted

  const t0 = Date.now();
  const scope = o.sessionId ?? null;
  const matches = (await similarAntibodies(o.text, IMMUNE_TOP_K, scope)).filter((m) => m.score >= threshold);
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
    scope,
    matches: matches.map(({ antibodyId, score, lessonText }) => ({ antibodyId, score, lessonText })),
    replays: [],
    untestable: [],
    decision: "no_match",
    blockedBy: null,
    ms: 0,
    runs: 0,
    createdAt: new Date(),
  };

  if (matches.length) {
    // The candidate: base + the proposed lesson (reused if a retried attempt already made it).
    const note = `candidate for recognition ${recognitionId}`;
    let candidate: Pick<Version, "versionId" | "change"> | null = await versions.findOne({ note }, { projection: { _id: 0, versionId: 1, change: 1 } });
    if (!candidate) {
      const lesson = await addLesson(o.text, { origin: o.label });
      candidate = await createVersion({
        parentVersionId: o.baseVersionId,
        change: { op: "add", lessonId: lesson.lessonId },
        label: o.label,
        createdBy: "immune",
        status: "candidate",
        note,
      });
    }
    rec.candidateVersionId = candidate.versionId;
    rec.lessonId = candidate.change!.lessonId;
    await openBudget(recognitionId, { maxRuns: IMMUNE_TOP_K * LIMITS.confirmTrials });

    let baseRuns = 0; // a first-time check that the base passes a case counts toward this recognition
    const casesTried = new Set<string>(); // antibodies from different memories can share one case
    for (const m of matches) {
      const caseKey = `${m.failingTaskId}/${m.targetAssertion}`;
      if (casesTried.has(caseKey)) continue;
      casesTried.add(caseKey);
      const { label: baseLabel, ranRuns } = await baseCaseLabel(o.baseVersionId, m.failingTaskId, m.targetAssertion);
      baseRuns += ranRuns;
      if (baseLabel !== "GOOD") {
        rec.untestable.push({ antibodyId: m.antibodyId, score: m.score, baseLabel });
        continue;
      }
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
      if (immuneDecision(probe.label) === "immune_blocked") {
        rec.blockedBy = m.antibodyId;
        break;
      }
    }
    rec.decision = rec.blockedBy ? "immune_blocked" : "immune_passed";
    rec.runs = (await costOf(recognitionId)).runs + baseRuns;
  }
  rec.ms = Date.now() - t0;

  // Save first; count recognitions and blocks only when this attempt is the one that saved it.
  try {
    await recognitions.insertOne({ ...rec });
  } catch (e) {
    const existing = await recognitions.findOne({ recognitionId }, { projection: { _id: 0 } });
    if (existing) return existing as Recognition;
    throw e;
  }
  for (const r of rec.replays) {
    await antibodies.updateOne({ antibodyId: r.antibodyId }, { $inc: { recognitions: 1, ...(r.antibodyId === rec.blockedBy ? { blocks: 1 } : {}) } });
  }
  return rec;
}

function createHashShort(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36);
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
