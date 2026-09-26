import assert from "node:assert/strict";
import { test } from "node:test";
import {
  acceptRepair,
  classify,
  countOutcomes,
  immuneDecision,
  outcomeOf,
  regressionDecision,
  screenStatus,
  verifyVerdict,
} from "@/lib/bisect/evidence";
import type { Counts } from "@/lib/types";

const c = (pass: number, targetFail = 0, otherFail = 0, error = 0): Counts => ({ pass, targetFail, otherFail, error });
const run = (assertions: [string, boolean][], error: string | null = null) => ({
  error,
  assertions: assertions.map(([name, passed]) => ({ name, passed })),
});

test("outcome: error, pass, target_fail, other_fail", () => {
  assert.equal(outcomeOf(run([["a", true]], "boom"), "a"), "error");
  assert.equal(outcomeOf(run([["a", true], ["b", true]]), "a"), "pass");
  assert.equal(outcomeOf(run([["a", false], ["b", false]]), "a"), "target_fail");
  assert.equal(outcomeOf(run([["a", true], ["b", false]]), "a"), "other_fail");
});

test("countOutcomes tallies each run once", () => {
  const runs = [run([["a", true]]), run([["a", false]]), run([["a", false]]), run([["a", true]], "x")];
  assert.deepEqual(countOutcomes(runs, "a"), c(1, 2, 0, 1));
});

test("confirm: all 5 pass → GOOD", () => assert.equal(classify(c(5)), "GOOD"));
test("confirm: 3 target fails → BAD", () => assert.equal(classify(c(2, 3)), "BAD"));
test("confirm: 5 target fails → BAD", () => assert.equal(classify(c(0, 5)), "BAD"));
test("confirm: 2 target fails → INCONCLUSIVE", () => assert.equal(classify(c(3, 2)), "INCONCLUSIVE"));
test("confirm: other failures never count toward BAD", () => assert.equal(classify(c(0, 2, 3)), "INCONCLUSIVE"));
test("confirm: 4 pass + 1 other fail is not GOOD", () => assert.equal(classify(c(4, 0, 1)), "INCONCLUSIVE"));
test("confirm: 4 pass + 1 infra error is not GOOD", () => assert.equal(classify(c(4, 0, 0, 1)), "INCONCLUSIVE"));
test("confirm: more than 2 infra errors → INCONCLUSIVE", () => assert.equal(classify(c(0, 2, 0, 3)), "INCONCLUSIVE"));

test("screen: both pass → ok; any failure → fail; infra error → insufficient_evidence", () => {
  assert.equal(screenStatus(c(2)), "ok");
  assert.equal(screenStatus(c(1, 1)), "fail");
  assert.equal(screenStatus(c(1, 0, 1)), "fail");
  assert.equal(screenStatus(c(1, 0, 0, 1)), "insufficient_evidence");
});

test("verify: only the exact four-way pattern is verified", () => {
  const ok = { parent: "GOOD", introducing: "BAD", current: "BAD", currentMinusSuspect: "GOOD" } as const;
  assert.equal(verifyVerdict(ok), "verified");
  assert.equal(verifyVerdict({ ...ok, parent: "INCONCLUSIVE" }), "inconclusive");
  assert.equal(verifyVerdict({ ...ok, introducing: "INCONCLUSIVE" }), "inconclusive");
  assert.equal(verifyVerdict({ ...ok, current: "GOOD" }), "inconclusive");
  assert.equal(verifyVerdict({ ...ok, currentMinusSuspect: "BAD" }), "inconclusive");
});

test("accept repair: failing task GOOD and nothing previously GOOD broke", () => {
  const rows = [
    { taskId: "t1", before: "GOOD" as const, after: "GOOD" as const },
    { taskId: "t2", before: "INCONCLUSIVE" as const, after: "BAD" as const }, // wasn't GOOD before: doesn't block
  ];
  assert.deepEqual(acceptRepair("GOOD", rows), { accepted: true, broken: [] });
  assert.deepEqual(acceptRepair("INCONCLUSIVE", rows), { accepted: false, broken: [] });
  const broke = [...rows, { taskId: "t3", before: "GOOD" as const, after: "INCONCLUSIVE" as const }];
  assert.deepEqual(acceptRepair("GOOD", broke), { accepted: false, broken: ["t3"] });
});

test("immune: only a BAD replay blocks", () => {
  assert.equal(immuneDecision("BAD"), "immune_blocked");
  assert.equal(immuneDecision("GOOD"), "immune_passed");
  assert.equal(immuneDecision("INCONCLUSIVE"), "immune_passed");
});

test("regression: BAD → confirmed, GOOD → false alarm", () => {
  assert.equal(regressionDecision("BAD"), "regression_confirmed");
  assert.equal(regressionDecision("GOOD"), "false_alarm");
  assert.equal(regressionDecision("INCONCLUSIVE"), "inconclusive");
});
