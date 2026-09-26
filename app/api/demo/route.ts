import { NextResponse } from "next/server";
import { CASE_COPY } from "@/lib/demo";
import { col } from "@/lib/memory/collections";

export const dynamic = "force-dynamic";

// Demo cases: every history built with a known planted answer, newest first, with its latest investigation.
export async function GET() {
  const { histories, investigations } = await col();
  const hs = await histories.find({ groundTruth: { $exists: true } }, { projection: { _id: 0 } }).sort({ createdAt: -1 }).toArray();
  const seen = new Set<string>();
  const cases = [];
  for (const h of hs) {
    const gt = h.groundTruth!;
    if (seen.has(gt.seedId)) continue; // newest history per planted lesson
    seen.add(gt.seedId);
    const latest = await investigations.findOne(
      { historyId: h.historyId, failureTaskId: gt.failingTaskId },
      { sort: { startedAt: -1 }, projection: { _id: 0, investigationId: 1, verdict: 1, acceptance: 1, suspect: 1 } },
    );
    cases.push({
      historyId: h.historyId,
      seedId: gt.seedId,
      ...(CASE_COPY[gt.seedId] ?? { title: `Planted ${gt.seedId}`, blurb: "" }),
      taskId: gt.failingTaskId,
      target: gt.targetAssertion,
      goodVersionId: h.goodVersionId ?? null,
      versions: h.versionIds.length,
      latest,
    });
  }
  return NextResponse.json(cases.sort((a, b) => a.seedId.localeCompare(b.seedId)));
}
