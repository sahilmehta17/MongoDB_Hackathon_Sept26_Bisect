// npm run seed  (MONGODB_DB=bisect_test npm run seed for a throwaway database)
// Loads data/*.yaml into Atlas: indexes, tasks (with embeddings of the request), snapshots and the
// agent config. Idempotent: upserts by id, re-embeds only tasks whose request text changed, and
// removes tasks/snapshots no longer in data/. Never creates lessons or versions.
import { mongoHosts } from "@/lib/env";
import { dataVersion, yamlAgentConfig, yamlSnapshots, yamlTasks } from "@/lib/data/yaml";
import { col, ensureIndexes, sleep, TASK_INDEX, type TaskDoc } from "@/lib/memory/collections";
import { getClient, getDb } from "@/lib/memory/db";
import { embed, EMBED_DIMS } from "@/lib/memory/embed";

async function main() {
  const db = await getDb();
  console.log(`cluster ${mongoHosts(process.env.MONGODB_URI ?? "").join(",")}, database ${db.databaseName}`);

  console.log("indexes:");
  for (const line of await ensureIndexes()) console.log("  •", line);

  const c = await col();
  const version = dataVersion();

  // Tasks: reuse the stored embedding when the request text is unchanged.
  const tasks = yamlTasks();
  const ids = tasks.map((t) => t.taskId);
  if (new Set(ids).size !== ids.length) throw new Error("duplicate taskId in data/tasks.yaml");
  const stored = new Map(
    (await c.tasks.find({}, { projection: { _id: 0, taskId: 1, request: 1, embedding: 1 } }).toArray()).map((t) => [t.taskId, t]),
  );
  const toEmbed = tasks.filter((t) => {
    const s = stored.get(t.taskId);
    return !(s && s.request === t.request && s.embedding?.length === EMBED_DIMS);
  });
  const fresh = new Map<string, number[]>();
  if (toEmbed.length) {
    const vecs = await embed(toEmbed.map((t) => t.request), "document");
    toEmbed.forEach((t, i) => fresh.set(t.taskId, vecs[i]));
  }
  const docs: TaskDoc[] = tasks.map((t, seq) => ({
    ...t,
    seq,
    embedding: fresh.get(t.taskId) ?? stored.get(t.taskId)!.embedding!,
  }));
  await c.tasks.bulkWrite(
    docs.map((d) => ({ replaceOne: { filter: { taskId: d.taskId }, replacement: d, upsert: true } })),
  );
  const staleTasks = await c.tasks.deleteMany({ taskId: { $nin: ids } });

  // Snapshots.
  const snaps = yamlSnapshots();
  await c.snapshots.bulkWrite(
    snaps.map((s) => ({ replaceOne: { filter: { snapshotId: s.snapshotId }, replacement: s, upsert: true } })),
  );
  const staleSnaps = await c.snapshots.deleteMany({ snapshotId: { $nin: snaps.map((s) => s.snapshotId) } });

  // Agent config (prompts, tool schemas, house rules).
  await c.config.replaceOne(
    { _id: "agent" },
    { ...yamlAgentConfig(), dataVersion: version, updatedAt: new Date() },
    { upsert: true },
  );

  // Wait until Vector Search sees every task (the index catches up asynchronously).
  const searchable = await waitForTasksSearchable(docs[0].embedding!, docs.length);

  const bySplit: Record<string, number> = {};
  for (const t of tasks) bySplit[`${t.split}/${t.workflow}`] = (bySplit[`${t.split}/${t.workflow}`] ?? 0) + 1;
  const [nTasks, nSnaps, nConfig, nLessons, nVersions, nHistories, nRuns] = await Promise.all([
    c.tasks.countDocuments(),
    c.snapshots.countDocuments(),
    c.config.countDocuments(),
    c.lessons.countDocuments(),
    c.versions.countDocuments(),
    c.histories.countDocuments(),
    c.runs.countDocuments(),
  ]);
  console.log(`tasks: ${nTasks} (${toEmbed.length} embedded now, ${tasks.length - toEmbed.length} reused, ${staleTasks.deletedCount} stale removed)`);
  console.log("  by split/workflow:", bySplit);
  console.log(`  ${TASK_INDEX} returns ${searchable}/${docs.length}`);
  console.log(`snapshots: ${nSnaps} (${snaps.map((s) => `${s.snapshotId}: ${s.orders.length} orders`).join(", ")}; ${staleSnaps.deletedCount} stale removed)`);
  console.log(`config: ${nConfig} doc (agent)`);
  console.log(`untouched: lessons ${nLessons}, versions ${nVersions}, histories ${nHistories}, runs ${nRuns}`);
  console.log(`data version: ${version}`);
}

async function waitForTasksSearchable(queryVector: number[], want: number): Promise<number> {
  const { tasks } = await col();
  const t0 = Date.now();
  for (;;) {
    const n = (
      await tasks
        .aggregate([
          { $vectorSearch: { index: TASK_INDEX, path: "embedding", queryVector, numCandidates: Math.max(100, want * 2), limit: want } },
          { $project: { _id: 0, taskId: 1 } },
        ])
        .toArray()
    ).length;
    if (n >= want) return n;
    if (Date.now() - t0 > 60_000) throw new Error(`${TASK_INDEX} returns only ${n}/${want} tasks after 60s`);
    await sleep(1000);
  }
}

main()
  .then(async () => (await getClient()).close())
  .catch(async (e) => {
    console.error(e instanceof Error ? e.message : e);
    await getClient()
      .then((c) => c.close())
      .catch(() => {});
    process.exit(1);
  });
