// Reads the hand-written data in data/*.yaml from disk (scripts and offline checks only).
// The app itself reads the same data from Atlas, loaded there by scripts/seed.ts, because the
// data/ folder isn't bundled into Vercel functions.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import type { AgentConfig, Snapshot, Task, ToolSchema } from "@/lib/types";

const camel = (k: string) => k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
// Keys under these are tool names, item ids or assertion names: keep them as written.
const KEEP_KEYS = new Set(["faults", "inventory"]);

export function toCamel(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(toCamel);
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [camel(k), KEEP_KEYS.has(k) ? x : toCamel(x)]));
  }
  return v;
}

function read(file: string): string {
  return readFileSync(path.join(process.cwd(), "data", file), "utf8");
}

export function yamlTasks(): Task[] {
  return toCamel(parse(read("tasks.yaml"))) as Task[];
}

export function yamlSnapshots(): Snapshot[] {
  return toCamel(parse(read("snapshots.yaml"))) as Snapshot[];
}

export interface SeedLesson {
  id: string; // "U1".."U8", "H1".."H3"
  text: string;
  rule?: string;
  learnedFrom?: string;
  targetAssertion?: string;
  triggerTasks?: string[];
}

export function yamlLessonSeed(): { useful: SeedLesson[]; harmful: SeedLesson[] } {
  return toCamel(parse(read("lessons_seed.yaml"))) as { useful: SeedLesson[]; harmful: SeedLesson[] };
}

export function yamlAgentConfig(): AgentConfig {
  const prompts = parse(read("prompts.yaml")) as Record<string, unknown>;
  const tools = parse(read("tools.yaml")) as { name: string; description: string; parameters: Record<string, unknown> }[];
  return {
    agentSystem: prompts.agent_system as string[],
    lessonsHeader: prompts.lessons_header as string,
    midrunLessonsHeader: prompts.midrun_lessons_header as string,
    reflectSystem: prompts.reflect_system as string,
    tools: tools.map(
      (t): ToolSchema => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }),
    ),
    // house_rules.yaml keys are assertion names: keep them snake_case.
    houseRules: parse(read("house_rules.yaml")) as AgentConfig["houseRules"],
  };
}

// Fingerprint of all data files, stored with the seeded data so a stale seed is detectable.
export function dataVersion(): string {
  const files = ["tasks.yaml", "snapshots.yaml", "lessons_seed.yaml", "prompts.yaml", "tools.yaml", "house_rules.yaml"];
  const h = createHash("sha256");
  for (const f of files) h.update(f).update(read(f));
  return "data:" + h.digest("hex").slice(0, 12);
}

// Optional data files (the teammate's task sets and calibration set): parsed as-is, or null if absent.
export function yamlOptional(file: string): unknown | null {
  try {
    return parse(read(file));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}
