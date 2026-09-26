// The demo request stream: training requests plus the fixed, labelled demo branch (spec 7).
// The branch is chosen by checking which task set covers each planted lesson's failing tasks,
// never by trying lessons until the demo passes.
import type { SeedLesson } from "@/lib/data/yaml";
import type { StreamItem } from "@/lib/types";

export interface DemoPlan {
  stream: StreamItem[];
  notes: string[]; // how each demo item was chosen, shown on the session page
}

export function buildDemoStream(o: {
  trainingTaskIds: string[]; // in data order
  gate: string[];
  monitoring: string[];
  harmful: SeedLesson[];
  rewordings: Record<string, string[]>; // seed id -> rewordings (from the calibration set, never the holdout)
  trainingCount?: number;
}): DemoPlan {
  const notes: string[] = [];
  const covered = (h: SeedLesson, set: string[]) => (h.triggerTasks ?? []).filter((t) => set.includes(t));

  // (1) a planted lesson the gate set covers → the gate should reject it.
  const byGate = o.harmful.find((h) => covered(h, o.gate).length > 0);
  if (byGate) notes.push(`(1) ${byGate.id}: the gate set covers ${covered(byGate, o.gate).join(", ")}, so the gate should catch it`);
  else notes.push("(1) skipped: no planted lesson has a failing task in the gate set");

  // (2) a planted lesson only the monitoring set covers → passes the gate, caught by monitoring.
  //     If none exists, one the monitoring set covers is injected (bypasses the gate), labelled so.
  const rest = o.harmful.filter((h) => h.id !== byGate?.id);
  const monOnly = rest.find((h) => covered(h, o.monitoring).length > 0 && covered(h, o.gate).length === 0);
  const monAny = monOnly ?? rest.find((h) => covered(h, o.monitoring).length > 0);
  if (!monAny) throw new Error("no planted lesson has a failing task in the monitoring set; the demo branch can't run");
  notes.push(
    monOnly
      ? `(2) ${monOnly.id}: only the monitoring set covers it (${covered(monOnly, o.monitoring).join(", ")}), so it goes through the gate`
      : `(2) ${monAny.id}: no planted lesson is covered only by monitoring, so ${monAny.id} is injected and labelled "bypassed the gate"`,
  );

  // (3) a reworded version of (2), submitted through the gate → the immune check should block it.
  const reworded = o.rewordings[monAny.id]?.[0];
  notes.push(reworded ? `(3) a rewording of ${monAny.id} from the calibration set` : `(3) skipped: no rewording of ${monAny.id} available`);

  const n = o.trainingCount ?? 8;
  const training = o.trainingTaskIds.slice(0, n).map((taskId): StreamItem => ({ kind: "training", taskId }));
  const half = Math.ceil(training.length / 2);
  const stream: StreamItem[] = [
    ...training.slice(0, half),
    ...(byGate ? [{ kind: "planted" as const, seedId: byGate.id, text: byGate.text, note: `planted ${byGate.id} (the gate set covers it)` }] : []),
    ...training.slice(half),
    monOnly
      ? { kind: "planted", seedId: monOnly.id, text: monOnly.text, note: `planted ${monOnly.id} (only monitoring covers it)` }
      : { kind: "injected", seedId: monAny.id, text: monAny.text, note: `injected ${monAny.id} (bypassed the gate)` },
    { kind: "monitor", note: "scheduled monitoring check" },
    ...(reworded ? [{ kind: "reworded" as const, seedId: monAny.id, text: reworded, note: `reworded ${monAny.id}` }] : []),
  ];
  return { stream, notes };
}
