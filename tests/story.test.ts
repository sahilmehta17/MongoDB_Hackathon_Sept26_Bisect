import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { formatDuration, toStory } from "@/lib/story";
import type { AutopilotView } from "@/lib/types";

// ap2: the demo session (5 seeded rules, 18 training requests, planted H2 and H1, reworded H1).
const view = JSON.parse(readFileSync("tests/fixtures/ap2.view.json", "utf8")) as AutopilotView;
const story = toStory(view);
const inv = view.investigations![0];
const rec = view.recognitions!.find((r) => r.decision === "immune_blocked")!;

test("rows follow the session in order, one per rule and moment", () => {
  assert.deepEqual(
    story.rows.map((r) => r.kind),
    ["routine", "blocked_tests", "blocked_tests", "live", "alarm", "bisect", "remembered", "blocked_memory"],
  );
});

test("start sentence counts the hand-written rules and passing test tasks", () => {
  assert.equal(story.start, `Started with ${view.startLessons!.length} hand-written rules. All 16 test tasks pass.`);
});

test("routine requests merge; every passed training request is counted once", () => {
  const passed = view.session.events.filter((e) => e.type === "training_run" && !e.msg.includes(" failed ")).length;
  const counted = story.rows.filter((r) => r.kind === "routine").reduce((n, r) => n + (r.items?.length ?? 0), 0);
  assert.equal(counted, passed);
});

test("rules blocked by the tests say what they broke, from the gate's evidence", () => {
  const [own, h2] = story.rows.filter((r) => r.kind === "blocked_tests");
  assert.match(own.line1, /^The agent's own rule: “If refund amount exceeds \$100/);
  assert.equal(own.chip, null);
  assert.match(own.line2[0], /^Blocked by tests: it broke an out-of-stock refund \(\d of 5 fresh runs\)$/);
  assert.equal(h2.chip, "planted");
  assert.match(h2.line2[0], /^Blocked by tests: it broke the return window \(\d of 5 fresh runs\)$/);
});

test("the planted rule that got past says why, from the demo plan", () => {
  const live = story.rows.find((r) => r.kind === "live")!;
  assert.equal(live.chip, "planted");
  assert.deepEqual(live.line2, ["Passed the tests and went live"]);
  assert.ok(live.expand.includes("Why it got past: the tests don't include a refund that times out after going through."));
});

test("the alarm uses the house rule's plain words", () => {
  const alarm = story.rows.find((r) => r.kind === "alarm")!;
  assert.equal(alarm.line1, "Monitoring: the agent refunds the customer twice");
  assert.deepEqual(alarm.line2, ["(5 of 5 fresh runs)"]);
});

test("the Bisect row's numbers come from the investigation", () => {
  const b = story.rows.find((r) => r.kind === "bisect")!;
  const i = inv.investigation;
  const others = i.recheck.filter((r) => r.taskId !== i.failureTaskId);
  assert.equal(b.line2[0], "With it: 5 of 5 double refunds. Without it: 0 of 5.");
  assert.equal(b.line2[1], `Removed only that rule. All ${others.length} other tasks still pass. ${Math.round(inv.elapsedMs / 1000)} s, ${inv.cost.runs} runs.`);
  assert.ok(b.expand[0].startsWith(`Searched ${i.line.length} versions, tested ${new Set(i.probes.map((p) => p.versionId)).size}.`));
  assert.ok(b.open);
});

test("the immune block shows similarity, the replay and the time", () => {
  const m = story.rows.find((r) => r.kind === "blocked_memory")!;
  const rep = rec.replays.find((r) => r.antibodyId === rec.blockedBy)!;
  assert.match(m.line1, /^The agent tried again in new words: “Timeouts mean/);
  assert.equal(m.line2[0], `Recognized (${Math.round(rep.score * 100)}% similar) → replayed the old case: 5 of 5 → blocked in ${Math.round(rec.ms / 100) / 10} s`);
  assert.ok(m.open);
});

test("header numbers: first catch from the investigation, repeat catch from the block", () => {
  assert.deepEqual(story.header.firstCatch, { seconds: Math.round(inv.elapsedMs / 1000), runs: inv.cost.runs, href: `/investigations/${inv.investigation.investigationId}` });
  assert.equal(story.header.repeatCatch?.runs, rec.runs);
  assert.equal(story.header.remembered, 1);
});

test("no ids in any visible text", () => {
  const visible = [story.start, ...story.rows.flatMap((r) => [r.line1, ...r.line2, ...r.expand, ...(r.items ?? []).map((x) => x.title)])].join("\n");
  assert.doesNotMatch(visible, /\b(v\d+|L\d+|ab\d+|inv\d+|rec\d+|ap\d+)\b/);
});

test("before any investigation, the header shows neither number", () => {
  const cut = view.session.events.findIndex((e) => e.type === "investigation_started");
  const early = toStory({ ...view, session: { ...view.session, status: "running", events: view.session.events.slice(0, cut) } });
  assert.equal(early.header.firstCatch, null);
  assert.equal(early.header.repeatCatch, null);
  assert.equal(early.status, "running");
});

test("rule text is shortened at a word boundary", async () => {
  const { shorten } = await import("@/lib/story");
  const long = "A tool call that times out did not go through: call the same tool again right away with the same arguments.";
  const s = shorten(long);
  assert.ok(s.length <= 81 && s.endsWith("…"));
  assert.ok(long.startsWith(s.slice(0, -1)));
  assert.doesNotMatch(s, /\bt…$/);
});

test("durations read naturally", () => {
  assert.equal(formatDuration(63), "1 min 3 s");
  assert.equal(formatDuration(8.6), "9 s");
  assert.equal(formatDuration(293), "4 min 53 s");
});
