import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { harmSentence, plain, toStage } from "@/lib/story";
import type { AutopilotView } from "@/lib/types";

// ap2: the recorded demo session shown on the home page.
const view = JSON.parse(readFileSync("tests/fixtures/ap2.view.json", "utf8")) as AutopilotView;
// The first confirm run of the monitoring alarm, as saved (refund_timeout_07 on v65).
const alarmRun = {
  toolCalls: [
    { tool: "issue_refund", result: "timeout" },
    { tool: "issue_refund", result: "ok" },
  ],
  finalStateSummary: { refund_count: 2, refunded_total: 80, amount_paid: 40 },
};
const stage = toStage(view, { threshold: 0.786, alarmRun });
const step = (key: string) => stage.steps.find((s) => s.key === key)!;
const inv = view.investigations![0];

test("nine steps in story order, grouped into the three parts", () => {
  assert.deepEqual(
    stage.steps.map((s) => `${s.part}:${s.key}`),
    ["autopilot:start", "autopilot:rejected", "autopilot:live", "autopilot:alarm", "bisect:found", "bisect:removed", "memory:remembered", "memory:blocked", "memory:try"],
  );
});

test("the rule cards keep one key per rule, so state changes animate", () => {
  const key = step("live").cards.at(-1)!.key;
  assert.equal(step("alarm").cards.at(-1)!.key, key);
  assert.equal(step("found").cards.at(-1)!.state, "suspect");
  assert.equal(step("removed").cards.at(-1)!.state, "removed");
  assert.equal(step("remembered").cards.at(-1)!.state, "shield");
  assert.equal(step("found").cards.at(-1)!.tag, "L52");
});

test("rejected rules say what they broke", () => {
  const r = step("rejected").cards.filter((c) => c.state === "rejected");
  assert.equal(r.length, 2);
  assert.match(r[0].note!, /^broke an out-of-stock refund \(\d of 5\)$/);
  assert.match(r[1].note!, /^broke the return window \(\d of 5\)$/);
  assert.equal(r[1].origin, "planted");
});

test("the alarm shows the concrete harm from the saved run", () => {
  assert.equal(plain(step("alarm").headline), "Monitoring catches it: the agent refunds the customer twice.");
  assert.equal(step("alarm").sub, "The first $40 refund timed out but had gone through, so the agent refunded again: **$80 back on a $40 order**.");
  assert.deepEqual(step("alarm").dots, [{ label: "Fresh runs", fail: 5, total: 5, note: "double refunds" }]);
});

test("Bisect's numbers come from the investigation", () => {
  assert.deepEqual(
    step("found").dots!.map((d) => [d.fail, d.total]),
    [
      [5, 5],
      [0, 5],
    ],
  );
  assert.equal(plain(step("removed").sub!), "Re-checked 15 other tasks: all 13 that passed before still pass, and 2 that failed now pass.");
  assert.equal(step("removed").metric, `${Math.round(inv.elapsedMs / 1000)} s · ${inv.cost.runs} fresh runs`);
});

test("the reworded rule is compared with the remembered one and blocked", () => {
  const b = step("blocked");
  assert.match(plain(b.headline), /^The same idea in new words is blocked in \d+(\.\d)? s\.$/);
  assert.equal(b.compare!.between, "81% similar");
  assert.equal(b.compare!.new.state, "blocked");
  assert.match(plain(b.sub!), /81% similar to the remembered rule \(threshold 79%\), so the old request was replayed with it: 5 of 5 runs failed\.$/);
});

test("no ids in headlines or sentences (ids only as small card tags)", () => {
  const text = stage.steps.flatMap((s) => [s.headline, s.sub ?? "", s.metric ?? ""]).join("\n");
  assert.doesNotMatch(text, /\b(v\d+|L\d+|ab\d+|inv\d+|rec\d+|ap\d+)\b/);
});

test("the harm sentence only speaks about double refunds it can see", () => {
  assert.equal(harmSentence({ finalStateSummary: { refund_count: 1, refunded_total: 40, amount_paid: 40 } }), undefined);
  assert.equal(harmSentence(null), undefined);
});

test("the header names the planted case the session runs against", () => {
  assert.equal(stage.caseTitle, "The retry that refunds twice");
});

test("every step before the live one marks its key moment", () => {
  for (const s of stage.steps.filter((x) => x.key !== "try")) {
    assert.ok(`${s.headline} ${s.sub ?? ""}`.includes("**"), s.key);
  }
  assert.equal(harmSentence(alarmRun), "The first $40 refund timed out but had gone through, so the agent refunded again: **$80 back on a $40 order**.");
});
