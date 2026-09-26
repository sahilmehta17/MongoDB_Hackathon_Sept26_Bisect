// Antibodies: every verified conviction is remembered as the convicted lesson's text and embedding,
// plus the case that proved it (failing task + target assertion). That case is also a pinned test
// every later candidate and repair must pass. One antibody per rule and memory: a repeat conviction
// of the same rule is recorded on the existing antibody.
import { col, nextId } from "@/lib/memory/collections";
import { embedOne } from "@/lib/memory/embed";
import type { Antibody, Investigation } from "@/lib/types";

export const scopeOf = (inv: Pick<Investigation, "sessionId">) => inv.sessionId ?? "lab";
const sameRule = (a: string, b: string) => a.replace(/\s+/g, " ").trim().toLowerCase() === b.replace(/\s+/g, " ").trim().toLowerCase();

// Called right after the four-way check verifies the suspect, before the repair and re-check, so a
// budget stop later can't lose a proven conviction. `repair` becomes "removed" if the repair is accepted.
export async function createAntibody(investigationId: string, repair: Antibody["repair"]): Promise<string | null> {
  const { antibodies, investigations } = await col();
  const already = await antibodies.findOne({ convictions: investigationId });
  if (already) return already.antibodyId; // retried step
  const inv = await investigations.findOne({ investigationId });
  if (!inv?.suspect) return null;
  const scope = scopeOf(inv);

  const inScope = await antibodies.find({ scope }, { projection: { antibodyId: 1, lessonText: 1 } }).toArray();
  const same = inScope.find((a) => sameRule(a.lessonText, inv.suspect!.text));
  if (same) {
    await antibodies.updateOne({ antibodyId: same.antibodyId }, { $addToSet: { convictions: investigationId } });
    await log(investigationId, `the same rule was convicted before: recorded on antibody ${same.antibodyId} (one antibody per rule)`);
    return same.antibodyId;
  }

  // Evidence from the latest verification (a re-verification after a scan replaces the first).
  const last = (config: string) => [...inv.verification].reverse().find((p) => p.config === config);
  const withLesson = last("current");
  const without = last("current_minus_suspect");
  const doc: Antibody = {
    antibodyId: await nextId("ab"),
    scope,
    investigationId,
    convictions: [investigationId],
    convictedLessonId: inv.suspect.lessonId,
    lessonText: inv.suspect.text,
    embedding: await embedOne(inv.suspect.text, "document"),
    failingTaskId: inv.failureTaskId,
    targetAssertion: inv.targetAssertion,
    evidence: {
      withFails: withLesson?.counts.targetFail ?? 0,
      withoutFails: without?.counts.targetFail ?? 0,
      trials: withLesson?.trials ?? 0,
    },
    repair,
    label: inv.suspect.origin,
    createdAt: new Date(),
    recognitions: 0,
    blocks: 0,
  };
  await antibodies.insertOne({ ...doc });
  const { waitAntibodySearchable } = await import("@/lib/immune/recognize");
  await waitAntibodySearchable(doc.antibodyId, doc.embedding);
  await log(investigationId, `antibody ${doc.antibodyId} created from ${doc.convictedLessonId} (${scope} memory): its case is now a pinned test`);
  return doc.antibodyId;
}

export async function markRepaired(antibodyId: string): Promise<void> {
  const { antibodies } = await col();
  await antibodies.updateOne({ antibodyId }, { $set: { repair: "removed" } });
}

async function log(investigationId: string, msg: string): Promise<void> {
  const { investigations } = await col();
  await investigations.updateOne({ investigationId }, { $push: { log: { at: new Date(), msg } } });
}
