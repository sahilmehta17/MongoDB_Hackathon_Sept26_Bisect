import assert from "node:assert/strict";
import { test } from "node:test";
import { buildDemoStream } from "@/lib/autopilot/stream";

const harmful = [
  { id: "H1", text: "retry", triggerTasks: ["refund_timeout_07", "refund_timeout_08"] },
  { id: "H2", text: "loyal", triggerTasks: ["refund_loyal_late_11"] },
  { id: "H3", text: "email", triggerTasks: ["address_email_24"] },
];
const training = ["t1", "t2", "t3", "t4", "t5", "t6"];

test("gate-covered lesson goes first; a monitoring-only lesson goes through the gate", () => {
  const p = buildDemoStream({ trainingTaskIds: training, gate: ["refund_timeout_07"], monitoring: ["address_email_24"], harmful, rewordings: { H3: ["email shortcut reworded"] }, trainingCount: 4 });
  const kinds = p.stream.map((s) => s.kind);
  assert.deepEqual(kinds, ["training", "training", "planted", "training", "training", "planted", "monitor", "reworded"]);
  assert.equal((p.stream[2] as { seedId: string }).seedId, "H1");
  assert.equal((p.stream[5] as { seedId: string }).seedId, "H3");
  assert.equal((p.stream[7] as { text: string }).text, "email shortcut reworded");
});

test("when no lesson is covered only by monitoring, it is injected and labelled", () => {
  const p = buildDemoStream({ trainingTaskIds: training, gate: ["refund_timeout_07", "address_email_24"], monitoring: ["address_email_24"], harmful, rewordings: {}, trainingCount: 2 });
  const item = p.stream.find((s) => s.kind === "injected");
  assert.ok(item);
  assert.match(p.notes.join(" "), /bypassed the gate/);
  assert.ok(!p.stream.some((s) => s.kind === "reworded"), "no rewording available → step (3) skipped, not invented");
});

test("no monitoring coverage at all is an error, not a silent demo", () => {
  assert.throws(() => buildDemoStream({ trainingTaskIds: training, gate: [], monitoring: [], harmful, rewordings: {} }));
});
