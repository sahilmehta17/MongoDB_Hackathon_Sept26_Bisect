// Run records: one document per (task, version, trial) run, keyed by the caller's runId.
import type { Filter } from "mongodb";
import type { RunRecord } from "@/lib/types";
import { col } from "./collections";

// Upsert by runId: a retried step overwrites its own record instead of adding a duplicate.
export async function saveRun(run: RunRecord): Promise<void> {
  const { runs } = await col();
  await runs.replaceOne({ runId: run.runId }, { ...run, createdAt: run.createdAt ?? new Date() }, { upsert: true });
}

export async function getRun(runId: string): Promise<RunRecord | null> {
  const { runs } = await col();
  return runs.findOne({ runId }, { projection: { _id: 0 } });
}

// Runs in the order asked for; ids with no saved run are skipped.
export async function getRunsByIds(runIds: string[]): Promise<RunRecord[]> {
  if (!runIds.length) return [];
  const { runs } = await col();
  const docs = await runs.find({ runId: { $in: runIds } }, { projection: { _id: 0 } }).toArray();
  const byId = new Map(docs.map((r) => [r.runId, r]));
  return runIds.flatMap((id) => byId.get(id) ?? []);
}

// Oldest first. e.g. findRuns({ taskId, versionId }) or findRuns({ "retrievedLessons.id": "L3" }).
export async function findRuns(filter: Filter<RunRecord>, limit = 500): Promise<RunRecord[]> {
  const { runs } = await col();
  return runs.find(filter, { projection: { _id: 0 } }).sort({ createdAt: 1, runId: 1 }).limit(limit).toArray();
}
