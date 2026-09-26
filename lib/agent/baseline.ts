// The baseline: an agent version with no lessons, used for zero-lesson runs and evals.
// Created once and remembered in the config collection.
import { getDb } from "@/lib/memory/db";
import { createHistory } from "@/lib/memory/histories";

type BaselineDoc = { _id: string; versionId: string };

export async function baselineVersionId(): Promise<string> {
  const config = (await getDb()).collection<BaselineDoc>("config");
  const found = await config.findOne({ _id: "baseline" });
  if (found) return found.versionId;
  const h = await createHistory({ note: "baseline: the agent with no lessons" });
  // If two callers race, the first one's version wins; the other history is simply unused.
  await config.updateOne({ _id: "baseline" }, { $setOnInsert: { versionId: h.versionIds[0] } }, { upsert: true });
  return (await config.findOne({ _id: "baseline" }))!.versionId;
}
