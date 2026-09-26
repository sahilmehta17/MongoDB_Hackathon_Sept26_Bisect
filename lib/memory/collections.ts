// Every Atlas collection Bisect uses, the atomic id counter, and the indexes (btree + Vector Search).
import { MongoServerError, type Collection } from "mongodb";
import type { AgentConfig, Antibody, Budget, History, Investigation, Lesson, Recognition, RunRecord, Snapshot, Task, Version } from "@/lib/types";
import { getDb } from "./db";
import { EMBED_DIMS } from "./embed";

// Stored task: the task plus its position in data/tasks.yaml, so listings keep the file's order.
export type TaskDoc = Task & { seq: number };
// The prompts, tool schemas and house rules, as one document with _id "agent".
export type ConfigDoc = AgentConfig & { _id: string; dataVersion: string; updatedAt: Date };
export type Counter = { _id: string; seq: number };
// Query embeddings, stored once per (model, text) so the same query always ranks lessons identically
// (Voyage returns slightly different vectors for the same text across calls).
export type QueryEmbedding = { _id: string; model: string; text: string; embedding: number[]; createdAt: Date };

export async function col() {
  const db = await getDb();
  return {
    tasks: db.collection<TaskDoc>("tasks"),
    snapshots: db.collection<Snapshot>("snapshots"),
    config: db.collection<ConfigDoc>("config"),
    lessons: db.collection<Lesson>("lessons"),
    versions: db.collection<Version>("versions"),
    histories: db.collection<History>("histories"),
    runs: db.collection<RunRecord>("runs"),
    investigations: db.collection<Investigation>("investigations"),
    budgets: db.collection<Budget>("budgets"),
    antibodies: db.collection<Antibody>("antibodies"),
    recognitions: db.collection<Recognition>("recognitions"),
    counters: db.collection<Counter>("counters"),
    queryEmbeddings: db.collection<QueryEmbedding>("query_embeddings"),
  };
}

// Readable ids from an atomic per-prefix sequence: "L1", "v7", "h2", "inv3", "ab1", "ap1".
export async function nextId(prefix: "L" | "v" | "h" | "inv" | "ab" | "ap" | "rec"): Promise<string> {
  const { counters } = await col();
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await counters.findOneAndUpdate(
        { _id: prefix },
        { $inc: { seq: 1 } },
        { upsert: true, returnDocument: "after" },
      );
      if (!r) throw new Error(`counter ${prefix} did not return a value`);
      return `${prefix}${r.seq}`;
    } catch (e) {
      // Two first-ever upserts racing on the same counter: one loses with a duplicate key; retry it.
      if (e instanceof MongoServerError && e.code === 11000 && attempt < 3) continue;
      throw e;
    }
  }
}

export const LESSON_INDEX = "lessons_vec";
export const TASK_INDEX = "tasks_vec";
export const ANTIBODY_INDEX = "antibodies_vec";

const VECTOR_INDEXES: { coll: "lessons" | "tasks" | "antibodies"; name: string; filters: string[] }[] = [
  { coll: "lessons", name: LESSON_INDEX, filters: ["lessonId"] },
  { coll: "tasks", name: TASK_INDEX, filters: ["taskId", "split", "workflow"] },
  { coll: "antibodies", name: ANTIBODY_INDEX, filters: ["antibodyId"] },
];

function vectorDefinition(filters: string[]) {
  return {
    fields: [
      { type: "vector", path: "embedding", numDimensions: EMBED_DIMS, similarity: "cosine" },
      ...filters.map((path) => ({ type: "filter", path })),
    ],
  };
}

// Order-insensitive fingerprint of an index definition, to spot one that needs updating.
function defKey(def: unknown): string {
  const fields = ((def as { fields?: Record<string, unknown>[] })?.fields ?? []).map((f) =>
    JSON.stringify([f.type, f.path, f.numDimensions ?? null, f.similarity ?? null]),
  );
  return fields.sort().join("|");
}

type SearchIndexInfo = { name: string; status?: string; queryable?: boolean; latestDefinition?: unknown };

const INDEX_WAIT_MS = 180_000;

// Idempotent. Creates the btree indexes and the three Vector Search indexes (updating one whose
// definition changed), then waits until every search index is READY and queryable.
export async function ensureIndexes(): Promise<string[]> {
  const c = await col();
  const report: string[] = [];

  await Promise.all([
    c.tasks.createIndex({ taskId: 1 }, { unique: true }),
    c.snapshots.createIndex({ snapshotId: 1 }, { unique: true }),
    c.lessons.createIndex({ lessonId: 1 }, { unique: true }),
    c.versions.createIndex({ versionId: 1 }, { unique: true }),
    c.versions.createIndex({ historyId: 1, index: 1 }),
    c.histories.createIndex({ historyId: 1 }, { unique: true }),
    c.runs.createIndex({ runId: 1 }, { unique: true }),
    c.runs.createIndex({ taskId: 1, versionId: 1 }),
    c.runs.createIndex({ "retrievedLessons.id": 1 }),
    c.investigations.createIndex({ investigationId: 1 }, { unique: true }),
    c.antibodies.createIndex({ antibodyId: 1 }, { unique: true }),
    c.antibodies.createIndex({ investigationId: 1 }, { unique: true }),
    c.recognitions.createIndex({ recognitionId: 1 }, { unique: true }),
    c.recognitions.createIndex({ createdAt: -1 }),
  ]);
  report.push("btree: 11 indexes ok");

  const action: Record<string, string> = {};
  for (const { coll, name, filters } of VECTOR_INDEXES) {
    const collection = c[coll] as unknown as Collection;
    const definition = vectorDefinition(filters);
    const [existing] = (await collection.listSearchIndexes(name).toArray()) as SearchIndexInfo[];
    if (!existing) {
      await collection.createSearchIndex({ name, type: "vectorSearch", definition });
      action[name] = "created";
    } else if (defKey(existing.latestDefinition) !== defKey(definition)) {
      await collection.updateSearchIndex(name, definition);
      action[name] = "updated";
    } else {
      action[name] = "exists";
    }
  }

  const t0 = Date.now();
  const pending = new Set(VECTOR_INDEXES.map((v) => v.name));
  const last: Record<string, SearchIndexInfo | undefined> = {};
  while (pending.size) {
    for (const { coll, name } of VECTOR_INDEXES) {
      if (!pending.has(name)) continue;
      const [info] = (await (c[coll] as unknown as Collection).listSearchIndexes(name).toArray()) as SearchIndexInfo[];
      last[name] = info;
      if (info?.status === "FAILED") throw new Error(`search index ${name} FAILED to build`);
      if (info?.status === "READY" && info.queryable) {
        pending.delete(name);
        report.push(`${name} on ${coll}: READY, queryable (${action[name]}, ${Date.now() - t0} ms wait)`);
      }
    }
    if (!pending.size) break;
    if (Date.now() - t0 > INDEX_WAIT_MS) {
      const states = [...pending].map((n) => `${n}=${last[n]?.status ?? "missing"}/queryable=${!!last[n]?.queryable}`);
      throw new Error(`search indexes not ready after ${INDEX_WAIT_MS / 1000}s: ${states.join(", ")}`);
    }
    await sleep(2000);
  }
  return report;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
