// Tasks, snapshots and agent config as the app reads them at runtime: from Atlas, where
// scripts/seed.ts puts them (data/ isn't bundled into Vercel functions). Cached per process;
// callers get copies, so mutating a snapshot during a run never touches the cache.
import type { AgentConfig, Snapshot, Task } from "@/lib/types";
import { col } from "@/lib/memory/collections";

// Loads once per process; a failed load is forgotten so the next call retries.
function lazy<T>(load: () => Promise<T>) {
  let p: Promise<T> | null = null;
  const get = () => {
    if (!p) {
      p = load();
      p.catch(() => (p = null));
    }
    return p;
  };
  return Object.assign(get, { clear: () => (p = null) });
}

const loadTasks = (withEmbedding: boolean) => async (): Promise<Task[]> => {
  const { tasks } = await col();
  const projection = withEmbedding ? { _id: 0, seq: 0 } : { _id: 0, seq: 0, embedding: 0 };
  const list = (await tasks.find({}, { projection }).sort({ seq: 1, taskId: 1 }).toArray()) as Task[];
  if (!list.length) throw new Error("no tasks in Atlas: run `npm run seed`");
  return list;
};
const tasksPlain = lazy(loadTasks(false));
const tasksWithEmbedding = lazy(loadTasks(true));

const snapshots = lazy(async () => {
  const { snapshots } = await col();
  const list = await snapshots.find({}, { projection: { _id: 0 } }).toArray();
  return new Map(list.map((s) => [s.snapshotId, s as Snapshot]));
});

const config = lazy(async () => {
  const { config } = await col();
  const doc = await config.findOne({ _id: "agent" }, { projection: { _id: 0, updatedAt: 0 } });
  if (!doc) throw new Error("agent config not found in Atlas: run `npm run seed`");
  const { dataVersion, ...agent } = doc;
  return { agent: agent as AgentConfig, dataVersion };
});

export async function getTask(taskId: string, o: { withEmbedding?: boolean } = {}): Promise<Task> {
  const t = (await (o.withEmbedding ? tasksWithEmbedding : tasksPlain)()).find((x) => x.taskId === taskId);
  if (!t) throw new Error(`task ${taskId} not found`);
  return structuredClone(t);
}

// All tasks in data/tasks.yaml order, optionally one split only.
export async function listTasks(split?: Task["split"], o: { withEmbedding?: boolean } = {}): Promise<Task[]> {
  const list = await (o.withEmbedding ? tasksWithEmbedding : tasksPlain)();
  return structuredClone(split ? list.filter((t) => t.split === split) : list);
}

export async function getSnapshot(snapshotId: string): Promise<Snapshot> {
  const s = (await snapshots()).get(snapshotId);
  if (!s) throw new Error(`snapshot ${snapshotId} not found (run \`npm run seed\`?)`);
  return structuredClone(s);
}

export async function getAgentConfig(): Promise<AgentConfig> {
  return structuredClone((await config()).agent);
}

// Fingerprint of data/*.yaml at the last seed (see dataVersion() in lib/data/yaml.ts).
export async function getDataVersion(): Promise<string> {
  return (await config()).dataVersion;
}

// Forget everything cached, e.g. after re-seeding under a long-running dev server.
export function clearDataCache(): void {
  for (const c of [tasksPlain, tasksWithEmbedding, snapshots, config]) c.clear();
}
