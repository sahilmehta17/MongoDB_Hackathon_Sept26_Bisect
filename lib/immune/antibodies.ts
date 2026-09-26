// Antibodies: every verified conviction is remembered as the convicted lesson's text and embedding,
// plus the case that proved it (failing task + target assertion). That case is also a pinned test
// every later candidate and repair must pass.
import { col, nextId } from "@/lib/memory/collections";
import { embedOne } from "@/lib/memory/embed";
import type { Antibody } from "@/lib/types";

export async function createAntibody(investigationId: string, repair: Antibody["repair"]): Promise<string | null> {
  const { antibodies, investigations } = await col();
  const existing = await antibodies.findOne({ investigationId });
  if (existing) return existing.antibodyId; // retried step
  const inv = await investigations.findOne({ investigationId });
  if (!inv?.suspect) return null;
  const withLesson = inv.verification.find((p) => p.config === "current");
  const without = inv.verification.find((p) => p.config === "current_minus_suspect");
  const doc: Antibody = {
    antibodyId: await nextId("ab"),
    investigationId,
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
  await antibodies.insertOne(doc);
  await investigations.updateOne(
    { investigationId },
    { $push: { log: { at: new Date(), msg: `antibody ${doc.antibodyId} created from ${doc.convictedLessonId}: its case is now a pinned test` } } },
  );
  return doc.antibodyId;
}
