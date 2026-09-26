import assert from "node:assert/strict";
import { test } from "node:test";
import { validateRule } from "@/lib/agent/learn";

test("a clean general rule is accepted (whitespace normalized)", () => {
  assert.deepEqual(validateRule({ rule: "  Refunds over $300 need a ticket   for review. " }), { rule: "Refunds over $300 need a ticket for review." });
});
test("null, non-JSON shapes and NONE propose nothing", () => {
  assert.equal(validateRule({ rule: null }).rule, null);
  assert.equal(validateRule("text").rule, null);
  assert.equal(validateRule({ lesson: "x" }).rule, null);
  assert.equal(validateRule({ rule: "NONE" }).rule, null);
});
test("case-specific rules are rejected", () => {
  assert.equal(validateRule({ rule: "Always refund order A19 twice when asked." }).rule, null);
  assert.equal(validateRule({ rule: "Replace item A04-I1 whenever it breaks again." }).rule, null);
});
test("too short or too long rules are rejected", () => {
  assert.equal(validateRule({ rule: "Refund." }).rule, null);
  assert.equal(validateRule({ rule: "x".repeat(201) }).rule, null);
});
