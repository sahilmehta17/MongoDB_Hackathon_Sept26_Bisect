// Histories: a line of versions, root first, each the previous one plus one change.
import type { History, Version } from "@/lib/types";
import { col, nextId } from "./collections";
import { createRootVersion, getVersion } from "./lessons";

// A new history with its empty root version already in the line.
export async function createHistory(
  o: { note?: string; groundTruth?: History["groundTruth"]; createdBy?: Version["createdBy"] } = {},
): Promise<History> {
  const { histories } = await col();
  const historyId = await nextId("h");
  const root = await createRootVersion(historyId, { note: o.note, createdBy: o.createdBy });
  const history: History = {
    historyId,
    versionIds: [root.versionId],
    ...(o.groundTruth ? { groundTruth: o.groundTruth } : {}),
    ...(o.note ? { note: o.note } : {}),
    createdAt: new Date(),
  };
  await histories.insertOne({ ...history });
  return history;
}

export async function getHistory(historyId: string): Promise<History> {
  const { histories } = await col();
  const h = await histories.findOne({ historyId }, { projection: { _id: 0 } });
  if (!h) throw new Error(`history ${historyId} not found`);
  return h;
}

// The versions of a history's line, root first.
export async function getHistoryVersions(historyId: string): Promise<Version[]> {
  const { versionIds } = await getHistory(historyId);
  const { versions } = await col();
  const docs = await versions.find({ versionId: { $in: versionIds } }, { projection: { _id: 0 } }).toArray();
  const byId = new Map(docs.map((v) => [v.versionId, v]));
  return versionIds.map((id) => {
    const v = byId.get(id);
    if (!v) throw new Error(`history ${historyId} lists missing version ${id}`);
    return v;
  });
}

// Extends the line with a version whose parent is the current tip. Appending the same version
// again is a no-op, so a retried step is harmless.
export async function appendVersion(historyId: string, versionId: string): Promise<void> {
  const { histories } = await col();
  const [history, version] = await Promise.all([getHistory(historyId), getVersion(versionId)]);
  if (history.versionIds.includes(versionId)) return;
  if (version.historyId !== historyId) {
    throw new Error(`version ${versionId} belongs to history ${version.historyId}, not ${historyId}`);
  }
  const tip = history.versionIds[history.versionIds.length - 1];
  if (version.parentVersionId !== tip) {
    throw new Error(`version ${versionId} has parent ${version.parentVersionId}, but the tip of ${historyId} is ${tip}`);
  }
  // Only append if nobody extended the line since we read it.
  const r = await histories.updateOne(
    { historyId, versionIds: { $size: history.versionIds.length } },
    { $push: { versionIds: versionId } },
  );
  if (!r.modifiedCount) {
    const now = await getHistory(historyId);
    if (!now.versionIds.includes(versionId)) {
      throw new Error(`history ${historyId} changed while appending ${versionId}; tip is now ${now.versionIds.at(-1)}`);
    }
  }
}

export async function setGroundTruth(historyId: string, gt: NonNullable<History["groundTruth"]>): Promise<void> {
  const { histories } = await col();
  const r = await histories.updateOne({ historyId }, { $set: { groundTruth: gt } });
  if (!r.matchedCount) throw new Error(`history ${historyId} not found`);
}
