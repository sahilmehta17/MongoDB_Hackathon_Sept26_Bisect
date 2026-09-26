// Lessons and versions. Both are immutable once written, so any old version can be rebuilt exactly:
// a version is its parent plus or minus exactly one lesson, and retrieval only ever reads a
// version's activeLessonIds.
import { createHash } from "node:crypto";
import { MongoServerError } from "mongodb";
import type { Lesson, Origin, Version, VersionStatus } from "@/lib/types";
import { col, LESSON_INDEX, nextId, sleep } from "./collections";
import { cosine, embedOne, VOYAGE_MODEL } from "./embed";

const SEARCHABLE_WAIT_MS = 60_000;
const NO_ID_OR_EMBEDDING = { _id: 0, embedding: 0 } as const;

// Deterministic ranking: best score first, ties broken by lesson id in natural order (L2 < L10).
function byScoreThenId(a: Lesson, b: Lesson): number {
  return (b.score ?? 0) - (a.score ?? 0) || a.lessonId.localeCompare(b.lessonId, "en", { numeric: true });
}

// Adds a lesson and returns once Vector Search can find it, so it is retrievable immediately.
export async function addLesson(
  text: string,
  o: { origin: Origin; seedId?: string; sourceRunId?: string | null; parentLessonIds?: string[] },
): Promise<Lesson> {
  const { lessons } = await col();
  const embedding = await embedOne(text, "document");
  const lesson: Lesson = {
    lessonId: await nextId("L"),
    text,
    origin: o.origin,
    ...(o.seedId ? { seedId: o.seedId } : {}),
    sourceRunId: o.sourceRunId ?? null,
    parentLessonIds: o.parentLessonIds ?? [],
    createdAt: new Date(),
  };
  await lessons.insertOne({ ...lesson, embedding });
  await waitUntilSearchable(lesson.lessonId, embedding);
  return lesson;
}

// Atlas Search indexes are eventually consistent: poll $vectorSearch until the new lesson shows up.
async function waitUntilSearchable(lessonId: string, embedding: number[]): Promise<number> {
  const { lessons } = await col();
  const t0 = Date.now();
  for (let delay = 200; ; delay = Math.min(delay * 2, 1000)) {
    const hits = await lessons
      .aggregate([
        {
          $vectorSearch: {
            index: LESSON_INDEX,
            path: "embedding",
            queryVector: embedding,
            numCandidates: 10,
            limit: 1,
            filter: { lessonId: { $eq: lessonId } },
          },
        },
        { $project: { _id: 0, lessonId: 1 } },
      ])
      .toArray();
    if (hits.length) return Date.now() - t0;
    if (Date.now() - t0 > SEARCHABLE_WAIT_MS) {
      throw new Error(`lesson ${lessonId} was not searchable in ${LESSON_INDEX} after ${SEARCHABLE_WAIT_MS / 1000}s`);
    }
    await sleep(delay);
  }
}

// Lessons in the order asked for, without embeddings. Throws if any id is unknown.
export async function getLessons(ids: string[]): Promise<Lesson[]> {
  if (!ids.length) return [];
  const { lessons } = await col();
  const docs = await lessons.find({ lessonId: { $in: ids } }, { projection: NO_ID_OR_EMBEDDING }).toArray();
  const byId = new Map(docs.map((d) => [d.lessonId, d as Lesson]));
  const missing = ids.filter((id) => !byId.has(id));
  if (missing.length) throw new Error(`lessons not found: ${missing.join(", ")}`);
  return ids.map((id) => byId.get(id)!);
}

// ---------- versions ----------

export async function createRootVersion(
  historyId: string,
  o: { note?: string; createdBy?: Version["createdBy"] } = {},
): Promise<Version> {
  const { versions } = await col();
  const version: Version = {
    versionId: await nextId("v"),
    historyId,
    index: 0,
    parentVersionId: null,
    activeLessonIds: [],
    change: null,
    status: "active",
    createdBy: o.createdBy ?? "learning",
    ...(o.note ? { note: o.note } : {}),
    createdAt: new Date(),
  };
  await versions.insertOne({ ...version });
  return version;
}

// A new version: the parent's lessons plus or minus exactly one. The label defaults to the
// origin of the lesson being added or removed.
export async function createVersion(o: {
  parentVersionId: string;
  change: { op: "add" | "remove"; lessonId: string };
  label?: Origin;
  createdBy: Version["createdBy"];
  status?: VersionStatus;
  note?: string;
  investigationId?: string;
  historyId?: string;
}): Promise<Version> {
  const parent = await getVersion(o.parentVersionId);
  const { lessonId, op } = o.change;
  const active = parent.activeLessonIds;
  if (op === "add" && active.includes(lessonId)) {
    throw new Error(`lesson ${lessonId} is already active in ${parent.versionId}`);
  }
  if (op === "remove" && !active.includes(lessonId)) {
    throw new Error(`lesson ${lessonId} is not active in ${parent.versionId}, so it can't be removed`);
  }
  const { lessons, versions } = await col();
  const lesson = await lessons.findOne({ lessonId }, { projection: { _id: 0, origin: 1 } });
  if (!lesson) throw new Error(`lesson ${lessonId} not found`);

  const version: Version = {
    versionId: await nextId("v"),
    historyId: o.historyId ?? parent.historyId,
    index: parent.index + 1,
    parentVersionId: parent.versionId,
    activeLessonIds: op === "add" ? [...active, lessonId] : active.filter((id) => id !== lessonId),
    change: { op, lessonId },
    label: o.label ?? lesson.origin,
    status: o.status ?? "active",
    createdBy: o.createdBy,
    ...(o.note ? { note: o.note } : {}),
    ...(o.investigationId ? { investigationId: o.investigationId } : {}),
    createdAt: new Date(),
  };
  await versions.insertOne({ ...version });
  return version;
}

export async function getVersion(versionId: string): Promise<Version> {
  const { versions } = await col();
  const v = await versions.findOne({ versionId }, { projection: { _id: 0 } });
  if (!v) throw new Error(`version ${versionId} not found`);
  return v;
}

// The one field of a version that may change after it is written: a candidate accepted or rejected.
export async function setVersionStatus(versionId: string, status: VersionStatus): Promise<void> {
  const { versions } = await col();
  const r = await versions.updateOne({ versionId }, { $set: { status } });
  if (!r.matchedCount) throw new Error(`version ${versionId} not found`);
}

// ---------- retrieval ----------

// The query vector for a text: the same vector every time, in every process. Voyage's output for
// one text varies slightly between calls, which could flip near-tied lessons between runs, so the
// first vector computed is stored in Atlas and reused.
const queryVectors = new Map<string, Promise<number[]>>();

export function queryVector(text: string): Promise<number[]> {
  let p = queryVectors.get(text);
  if (!p) {
    p = loadQueryVector(text);
    queryVectors.set(text, p);
    p.catch(() => queryVectors.delete(text));
    if (queryVectors.size > 5000) queryVectors.delete(queryVectors.keys().next().value!);
  }
  return p;
}

async function loadQueryVector(text: string): Promise<number[]> {
  const { queryEmbeddings } = await col();
  const _id = createHash("sha256").update(`${VOYAGE_MODEL}\0query\0${text}`).digest("hex");
  const hit = await queryEmbeddings.findOne({ _id }, { projection: { embedding: 1 } });
  if (hit) return hit.embedding;
  const embedding = await embedOne(text, "query");
  try {
    await queryEmbeddings.updateOne(
      { _id },
      { $setOnInsert: { model: VOYAGE_MODEL, text, embedding, createdAt: new Date() } },
      { upsert: true },
    );
  } catch (e) {
    if (!(e instanceof MongoServerError && e.code === 11000)) throw e; // a concurrent writer won
  }
  // Read back so concurrent first callers all use the one stored vector.
  const stored = await queryEmbeddings.findOne({ _id }, { projection: { embedding: 1 } });
  if (!stored) throw new Error("query embedding vanished after upsert");
  return stored.embedding;
}

// Top-k lessons for a query, from the version's active set only (minus `exclude`), via Atlas
// Vector Search. Lessons outside the version can never appear. Score is Atlas' cosine score,
// (1 + cosine) / 2.
export async function retrieveLessons(
  versionId: string,
  query: string,
  k: number,
  exclude?: Set<string>,
): Promise<Lesson[]> {
  const version = await getVersion(versionId);
  const allowed = version.activeLessonIds.filter((id) => !exclude?.has(id));
  if (!allowed.length || k <= 0) return [];
  const { lessons } = await col();
  const qv = await queryVector(query);
  const hits = (await lessons
    .aggregate([
      {
        $vectorSearch: {
          index: LESSON_INDEX,
          path: "embedding",
          queryVector: qv,
          numCandidates: Math.min(10_000, Math.max(100, 20 * k)),
          limit: k,
          filter: { lessonId: { $in: allowed } },
        },
      },
      { $project: { ...NO_ID_OR_EMBEDDING, score: { $meta: "vectorSearchScore" } } },
    ])
    .toArray()) as Lesson[];
  // Every active lesson has an embedding and was searchable before addLesson returned, so a short
  // result means the index is broken or behind. Fail loudly rather than run on the wrong lessons.
  const expected = Math.min(k, allowed.length);
  if (hits.length < expected) {
    throw new Error(`${LESSON_INDEX} returned ${hits.length} of ${expected} lessons for ${versionId}`);
  }
  return hits.sort(byScoreThenId);
}

// Frozen mode: exact cosine over only the given lessons. Nothing outside the list can appear,
// so a removed lesson is never backfilled. Scores use the same (1 + cosine) / 2 scale as Atlas.
export async function rankWithin(lessonIds: string[], query: string, k: number): Promise<Lesson[]> {
  const ids = [...new Set(lessonIds)];
  if (!ids.length || k <= 0) return [];
  const { lessons } = await col();
  const [docs, qv] = await Promise.all([
    lessons.find({ lessonId: { $in: ids } }, { projection: { _id: 0 } }).toArray(),
    queryVector(query),
  ]);
  const found = new Set(docs.map((d) => d.lessonId));
  const missing = ids.filter((id) => !found.has(id));
  if (missing.length) throw new Error(`lessons not found: ${missing.join(", ")}`);
  return docs
    .map(({ embedding, ...l }): Lesson => {
      if (!embedding?.length) throw new Error(`lesson ${l.lessonId} has no embedding`);
      return { ...l, score: (1 + cosine(qv, embedding)) / 2 };
    })
    .sort(byScoreThenId)
    .slice(0, k);
}
