// Data documents loaded into Atlas by scripts/seed.ts (the app can't read data/ on Vercel):
// the lesson seed, and the teammate's task sets and calibration set when they exist.
import type { SeedLesson } from "@/lib/data/yaml";
import { toCamel } from "@/lib/data/yaml";
import { getDb } from "@/lib/memory/db";

async function stored(id: string): Promise<unknown | null> {
  const doc = await (await getDb()).collection<{ _id: string; data: unknown }>("config").findOne({ _id: id });
  return doc?.data ?? null;
}

export async function getLessonSeed(): Promise<{ useful: SeedLesson[]; harmful: SeedLesson[] }> {
  const d = await stored("lesson_seed");
  if (!d) throw new Error("lesson seed not loaded: run npm run seed");
  return d as { useful: SeedLesson[]; harmful: SeedLesson[] };
}

// data/autopilot_sets.yaml: a gate set and a monitoring set of eval task ids. Entries may be plain
// ids or objects with a task id and a reason.
export async function getAutopilotSets(): Promise<{ gate: string[]; monitoring: string[] } | null> {
  const d = toCamel(await stored("autopilot_sets")) as Record<string, unknown> | null;
  if (!d) return null;
  const ids = (v: unknown): string[] =>
    (Array.isArray(v) ? v : []).map((x) => (typeof x === "string" ? x : String((x as Record<string, unknown>).taskId ?? (x as Record<string, unknown>).id ?? ""))).filter(Boolean);
  const gate = ids(d.gate ?? d.gateSet);
  const monitoring = ids(d.monitoring ?? d.monitoringSet ?? d.monitor);
  return gate.length && monitoring.length ? { gate, monitoring } : null;
}

export interface Calibration {
  rewordings: Record<string, string[]>; // convicted seed id (H1..) -> rewordings
  useful: string[]; // useful lessons that must not be blocked
}

// data/immune_calibration.yaml: rewordings per convicted rule plus useful lessons. Read tolerantly.
export async function getCalibration(): Promise<Calibration | null> {
  const d = toCamel(await stored("immune_calibration")) as Record<string, unknown> | null;
  if (!d) return null;
  const rewordings: Record<string, string[]> = {};
  const list = (d.convicted ?? d.rewordings ?? d.harmful ?? d.rules) as unknown;
  const text = (x: unknown) => (typeof x === "string" ? x : String((x as Record<string, unknown>)?.text ?? ""));
  if (Array.isArray(list)) {
    for (const item of list as Record<string, unknown>[]) {
      const id = String(item.id ?? item.seedId ?? item.of ?? item.rule ?? "");
      const words = (item.rewordings ?? item.variants ?? item.paraphrases) as unknown;
      if (id && Array.isArray(words)) rewordings[id] = words.map(text).filter(Boolean);
    }
  } else if (list && typeof list === "object") {
    for (const [id, words] of Object.entries(list as Record<string, unknown>)) {
      if (Array.isArray(words)) rewordings[id] = words.map(text).filter(Boolean);
    }
  }
  const usefulRaw = (d.useful ?? d.usefulLessons ?? []) as unknown;
  const useful = Array.isArray(usefulRaw) ? usefulRaw.map(text).filter(Boolean) : [];
  return { rewordings, useful };
}
