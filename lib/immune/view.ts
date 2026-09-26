// Everything /immune shows, in one response. Every number is read from saved records.
import { baselineVersionId } from "@/lib/agent/baseline";
import { costOf } from "@/lib/bisect/trials";
import { IMMUNE_THRESHOLD } from "@/lib/immune/threshold";
import { col } from "@/lib/memory/collections";
import { getDb } from "@/lib/memory/db";
import type { ImmuneView } from "@/lib/types";

type MenuDoc = { _id: string; items: ImmuneView["menu"] };

export async function immuneView(): Promise<ImmuneView> {
  const { antibodies, investigations, recognitions, versions } = await col();
  const abs = await antibodies.find({}, { projection: { _id: 0, embedding: 0 } }).sort({ createdAt: 1 }).toArray();

  const withFirst = await Promise.all(
    abs.map(async (ab) => {
      const inv = await investigations.findOne({ investigationId: ab.investigationId }, { projection: { startedAt: 1, finishedAt: 1 } });
      const cost = await costOf(ab.investigationId);
      const ms = inv?.finishedAt ? new Date(inv.finishedAt).getTime() - new Date(inv.startedAt).getTime() : null;
      return { ...ab, firstCatch: ms === null ? null : { ms, runs: cost.runs, modelCalls: cost.modelCalls } };
    }),
  );

  const feed = await recognitions.find({}, { projection: { _id: 0 } }).sort({ createdAt: -1 }).limit(30).toArray();
  const lastBlock = feed.find((r) => r.decision === "immune_blocked");
  const blocker = lastBlock ? withFirst.find((a) => a.antibodyId === lastBlock.blockedBy) : undefined;

  const repairs = await versions
    .find({ createdBy: "bisect", status: "active" }, { projection: { _id: 0, versionId: 1, investigationId: 1, change: 1 } })
    .sort({ createdAt: -1 })
    .limit(10)
    .toArray();
  const baseline = await baselineVersionId();
  const menuDoc = await (await getDb()).collection<MenuDoc>("config").findOne({ _id: "immune_menu" });

  return {
    threshold: IMMUNE_THRESHOLD,
    antibodies: withFirst,
    pinnedCount: new Set(abs.map((a) => `${a.failingTaskId}/${a.targetAssertion}`)).size,
    recognitions: feed,
    headline: {
      first:
        blocker?.firstCatch && lastBlock
          ? { investigationId: blocker.investigationId, antibodyId: blocker.antibodyId, ms: blocker.firstCatch.ms, runs: blocker.firstCatch.runs }
          : null,
      repeat: lastBlock
        ? {
            recognitionId: lastBlock.recognitionId,
            antibodyId: lastBlock.blockedBy!,
            ms: lastBlock.ms,
            runs: lastBlock.runs,
            similarity: lastBlock.replays.find((r) => r.antibodyId === lastBlock.blockedBy)?.score ?? 0,
          }
        : null,
    },
    baseVersions: [
      ...repairs.map((v) => ({
        versionId: v.versionId,
        label: `${v.versionId}: the agent after ${v.investigationId} removed ${v.change?.lessonId ?? "a lesson"}`,
      })),
      { versionId: baseline, label: `${baseline}: the agent with no lessons` },
    ],
    menu: menuDoc?.items ?? [],
  };
}
