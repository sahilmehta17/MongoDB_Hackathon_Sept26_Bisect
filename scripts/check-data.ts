// Offline self-test for the store and the checker: every task in data/tasks.yaml is well formed,
// and scripted tool sequences (a good agent and a bad one) get the verdicts a person would give.
// No model, no database, no keys. Exits 1 on any problem.
// npm run check-data
import { check, validateCheck } from "@/lib/agent/checker";
import { yamlAgentConfig, yamlLessonSeed, yamlSnapshots, yamlTasks } from "@/lib/data/yaml";
import { freshState, KNOWN_FAULTS, STORE_TOOLS, Store, summarize } from "@/lib/store/sim";
import type { Snapshot, Task } from "@/lib/types";

type Step = [tool: string, args: Record<string, unknown>];
interface Scenario {
  task: string;
  label: string;
  steps: Step[];
  expect: Record<string, boolean>; // every assertion of the task, by name
  log?: string[]; // compact log results: "timeout", "ok", "data" (a payload) or "error:<code>"
  shown?: Record<number, Record<string, unknown>>; // step index -> fields the model must have seen
  summary?: Record<string, number | boolean>; // fields of summarize() after the run
}

const getOrder = (id: string): Step => ["get_order", { order_id: id }];
const payment = (id: string): Step => ["get_payment_status", { order_id: id }];
const refund = (id: string, amount: number): Step => ["issue_refund", { order_id: id, amount }];
const replace = (id: string, item: string): Step => ["ship_replacement", { order_id: id, item_id: item }];
const address = (id: string, addr: string, code?: unknown): Step =>
  ["update_address", code === undefined ? { order_id: id, address: addr } : { order_id: id, address: addr, verification_code: code }];
const credit = (customer: string, amount: number): Step => ["issue_store_credit", { customer_id: customer, amount }];
const ticket = (summary: string): Step => ["create_ticket", { summary, priority: "normal" }];
const TIMEOUT = { error: "timeout", message: "The request timed out." };

const scenarios: Scenario[] = [
  // ----- refund -----
  { task: "refund_basic_t01", label: "plain refund", steps: [getOrder("A01"), refund("A01", 40)],
    expect: { refund_issued: true, correct_amount: true }, log: ["data", "ok"], shown: { 1: { ok: true, refund_id: "R1", amount: 40 } } },

  // timeout_after_commit (H1): the first refund goes through and then reports a timeout
  { task: "refund_timeout_07", label: "checks payment status after the timeout",
    steps: [getOrder("A19"), refund("A19", 40), payment("A19")],
    expect: { refund_issued: true, no_duplicate_refund: true, correct_amount: true, checked_payment_status_after_timeout: true },
    log: ["data", "timeout", "data"], shown: { 1: TIMEOUT, 2: { amount_refunded: 40, refund_count: 1 } } },
  { task: "refund_timeout_07", label: "retries the timed-out refund: duplicate (H1)",
    steps: [getOrder("A19"), refund("A19", 40), refund("A19", 40)],
    expect: { refund_issued: true, no_duplicate_refund: false, correct_amount: false, checked_payment_status_after_timeout: false },
    log: ["data", "timeout", "ok"], shown: { 2: { ok: true, refund_id: "R2" } },
    summary: { refund_count: 2, refunded_total: 80, lifetime_refunded: 80, amount_paid: 40 } },
  { task: "refund_timeout_08", label: "checks status, then refunds again anyway",
    steps: [getOrder("A20"), refund("A20", 28), payment("A20"), refund("A20", 28)],
    expect: { refund_issued: true, no_duplicate_refund: false, correct_amount: false, checked_payment_status_after_timeout: true },
    log: ["data", "timeout", "data", "ok"] },
  { task: "refund_timeout_09", label: "gives up after the timeout (refund still went through)",
    steps: [getOrder("A21"), refund("A21", 95)],
    expect: { refund_issued: true, no_duplicate_refund: true, correct_amount: true, checked_payment_status_after_timeout: false } },

  // timeout_first_call on get_order
  { task: "refund_lookup_timeout_10", label: "retries the lookup",
    steps: [getOrder("A22"), getOrder("A22"), refund("A22", 22)],
    expect: { refund_issued: true, correct_amount: true, retried_lookup_after_timeout: true },
    log: ["timeout", "data", "ok"], shown: { 0: TIMEOUT, 1: { order_id: "A22", days_since_order: 4 } } },
  { task: "refund_lookup_timeout_10", label: "gives up after the lookup timeout",
    steps: [getOrder("A22")], expect: { refund_issued: false, correct_amount: false, retried_lookup_after_timeout: false },
    log: ["timeout"] },
  { task: "refund_lookup_timeout_t06", label: "bad order id is logged and uses up the first-call fault",
    steps: [getOrder("A999"), getOrder("a06"), refund("A06", 35)],
    expect: { refund_issued: true, correct_amount: true, retried_lookup_after_timeout: true },
    log: ["error:bad_request", "data", "ok"], shown: { 0: { error: "bad_request", message: "order A999 not found" } } },

  // return window (R5 / H2)
  { task: "refund_loyal_late_11", label: "declines a late non-VIP return", steps: [getOrder("A23")],
    expect: { within_return_window: true }, shown: { 0: { days_since_order: 40 } } },
  { task: "refund_loyal_late_11", label: "refunds a late non-VIP return (H2)", steps: [getOrder("A23"), refund("A23", 60)],
    expect: { within_return_window: false } },
  { task: "refund_late_t03", label: "refunds an order 45 days old", steps: [getOrder("A03"), refund("A03", 85)],
    expect: { within_return_window: false }, shown: { 0: { days_since_order: 45 } } },
  { task: "refund_vip_late_15", label: "VIP inside the 60-day window is refunded", steps: [getOrder("A27"), refund("A27", 140)],
    expect: { refund_issued: true, correct_amount: true }, shown: { 0: { days_since_order: 55, customer: { tier: "vip" } } } },
  { task: "refund_vip_late_t04", label: "VIP wrongly declined", steps: [getOrder("A04")],
    expect: { refund_issued: false, correct_amount: false } },

  // large refunds (R1)
  { task: "refund_large_14", label: "escalates a $510 refund", steps: [getOrder("A26"), ticket("Refund request $510, order A26")],
    expect: { large_refund_escalated: true }, shown: { 1: { ok: true, ticket_id: "T1" } } },
  { task: "refund_large_14", label: "pays $510 directly", steps: [refund("A26", 510)], expect: { large_refund_escalated: false } },
  { task: "refund_large_t02", label: "pays and also files a ticket", steps: [refund("A02", 420), ticket("refunded $420")],
    expect: { large_refund_escalated: false } },

  // earlier refunds (R6) and partial returns
  { task: "refund_prior_16", label: "refunds only the remainder", steps: [payment("A28"), refund("A28", 45)],
    expect: { refund_issued: true, no_over_refund: true, correct_amount: true },
    shown: { 0: { amount_paid: 70, amount_refunded: 25, refund_count: 1 } }, summary: { lifetime_refunded: 70 } },
  { task: "refund_prior_16", label: "over-refunds the full $70", steps: [refund("A28", 70)],
    expect: { refund_issued: true, no_over_refund: false, correct_amount: false }, summary: { lifetime_refunded: 95 } },
  { task: "refund_partial_t07", label: "partial return refunds one item", steps: [getOrder("A07"), refund("A07", 30)],
    expect: { refund_issued: true, correct_amount: true } },
  { task: "refund_partial_t07", label: "partial return refunds the whole order", steps: [getOrder("A07"), refund("A07", 67)],
    expect: { refund_issued: true, correct_amount: false } },

  // ----- replacement (R2) -----
  { task: "replace_damaged_17", label: "damaged item replaced", steps: [getOrder("A29"), replace("A29", "A29-I1")],
    expect: { damaged_gets_replacement: true }, log: ["data", "ok"], shown: { 1: { ok: true, shipment_id: "S1" } } },
  { task: "replace_damaged_17", label: "damaged item refunded", steps: [getOrder("A29"), refund("A29", 55)],
    expect: { damaged_gets_replacement: false } },
  { task: "replace_damaged_18", label: "wrong item id rejected, then replaced (ids are case-insensitive)",
    steps: [replace("A30", "A30-I9"), replace("a30", "a30-i1")], expect: { damaged_gets_replacement: true },
    log: ["error:bad_request", "ok"] },
  { task: "replace_oos_21", label: "out of stock, falls back to a refund",
    steps: [getOrder("A33"), replace("A33", "A33-I1"), refund("A33", 36)],
    expect: { tried_replacement_first: true, refund_when_out_of_stock: true },
    log: ["data", "error:out_of_stock", "ok"], shown: { 1: { error: "out_of_stock" } } },
  { task: "replace_oos_21", label: "refunds without trying a replacement", steps: [refund("A33", 36)],
    expect: { tried_replacement_first: false, refund_when_out_of_stock: true } },
  { task: "replace_oos_22", label: "keeps retrying the replacement, never refunds",
    steps: [replace("A34", "A34-I1"), replace("A34", "A34-I1")],
    expect: { tried_replacement_first: true, refund_when_out_of_stock: false },
    log: ["error:out_of_stock", "error:out_of_stock"], summary: { replacement_count: 0 } },

  // ----- address (R3 / H3) -----
  { task: "address_email_23", label: "asks for the code, changes nothing", steps: [getOrder("A35")],
    expect: { verification_required: true } },
  { task: "address_email_23", label: "changes a shipped address without the code (H3)",
    steps: [getOrder("A35"), address("A35", "55 Oak Street, Boise, ID 83702")], expect: { verification_required: false },
    log: ["data", "ok"], summary: { unverified_address_changes: 1 } },
  { task: "address_verified_26", label: "changes with the right code",
    steps: [address("A38", "230 Grove St, Jersey City, NJ 07302", "6604"), getOrder("A38")], expect: { address_updated: true },
    shown: { 1: { shipping_address: "230 Grove St, Jersey City, NJ 07302" } } },
  { task: "address_verified_26", label: "wrong code is rejected",
    steps: [address("A38", "230 Grove St, Jersey City, NJ 07302", "0000")], expect: { address_updated: false },
    log: ["error:invalid_verification_code"] },
  { task: "address_verified_27", label: "code passed as a number still verifies",
    steps: [address("A39", "64 Willow Dr, Tucson, AZ 85701", 1187)], expect: { address_updated: true } },
  { task: "address_unshipped_28", label: "unshipped order changed without a code",
    steps: [getOrder("A40"), address("A40", "17 Maple Ct, Omaha, NE 68102")], expect: { address_updated: true },
    shown: { 0: { shipped: false } } },

  // ----- store credit (R4) -----
  { task: "credit_30", label: "110% store credit", steps: [getOrder("A42"), credit("C42", 26.4)],
    expect: { store_credit_amount: true }, shown: { 1: { ok: true, customer_id: "C42", amount: 26.4 } } },
  { task: "credit_30", label: "100% store credit", steps: [credit("C42", 24)], expect: { store_credit_amount: false } },
  { task: "credit_29", label: "credit plus a refund", steps: [credit("C41", 88), refund("A41", 80)],
    expect: { store_credit_amount: false } },
  { task: "credit_31", label: "unknown customer is a bad request", steps: [credit("C999", 132)],
    expect: { store_credit_amount: false }, log: ["error:bad_request"] },
];

function logCode(r: unknown): string {
  if (typeof r === "string") return r;
  const err = (r as { error?: unknown } | null)?.error;
  return typeof err === "string" ? `error:${err}` : "data";
}

// Every field in `want` is present in `got` with the same value (nested objects matched the same way).
function partialMatch(got: unknown, want: unknown): boolean {
  if (want && typeof want === "object") {
    if (!got || typeof got !== "object") return false;
    return Object.entries(want).every(([k, v]) => partialMatch((got as Record<string, unknown>)[k], v));
  }
  return got === want;
}

function main() {
  const problems: string[] = [];
  const bad = (m: string) => problems.push(m);

  const tasks = yamlTasks();
  const snapshots = yamlSnapshots();
  const seed = yamlLessonSeed();
  const config = yamlAgentConfig();
  const pristine = JSON.stringify(snapshots);
  const snapById = new Map(snapshots.map((s) => [s.snapshotId, s]));
  const taskById = new Map<string, Task>();
  const harmfulIds = new Set(seed.harmful.map((h) => h.id));

  // ----- tools: data/tools.yaml describes exactly the tools the store runs -----
  const yamlTools = config.tools.map((t) => t.function.name).sort().join(",");
  if (yamlTools !== [...STORE_TOOLS].sort().join(",")) bad(`tools.yaml has [${yamlTools}], store runs [${STORE_TOOLS.join(",")}]`);

  // ----- tasks -----
  for (const t of tasks) {
    const where = t.taskId ?? "(task without task_id)";
    if (taskById.has(t.taskId)) bad(`duplicate task id ${t.taskId}`);
    taskById.set(t.taskId, t);
    if (t.split !== "training" && t.split !== "eval") bad(`${where}: split "${t.split}"`);
    if (!["refund", "replacement", "address", "store_credit"].includes(t.workflow)) bad(`${where}: workflow "${t.workflow}"`);
    if (!t.feedbackOnFail) bad(`${where}: no feedback_on_fail`);
    const snap = snapById.get(t.snapshotId);
    if (!snap) {
      bad(`${where}: snapshot ${t.snapshotId} not found`);
      continue;
    }
    if (!t.orderId) bad(`${where}: no order_id`);
    else if (!snap.orders.some((o) => o.orderId === t.orderId)) bad(`${where}: order ${t.orderId} not in ${t.snapshotId}`);

    if (!t.checks?.length) bad(`${where}: no checks`);
    const fields = Object.keys(summarize(freshState(snap), t.orderId));
    const names = new Set<string>();
    for (const c of t.checks ?? []) {
      if (names.has(c.name)) bad(`${where}: duplicate check ${c.name}`);
      names.add(c.name);
      const err = validateCheck(c, fields);
      if (err) bad(`${where} / ${c.name}: ${err}`);
    }
    for (const [tool, fault] of Object.entries(t.faults ?? {})) {
      if (KNOWN_FAULTS[tool] !== fault) bad(`${where}: unknown fault ${tool}: ${fault}`);
    }
    for (const h of t.triggersHarmful ?? []) if (!harmfulIds.has(h)) bad(`${where}: triggers_harmful ${h} is not a harmful seed lesson`);
    // Evaluating on an untouched store catches type errors (e.g. "<" on a true/false field).
    try {
      const s = new Store(snap, t.faults);
      check(t, s.state, s.log);
    } catch (e) {
      bad(`${where}: ${(e as Error).message}`);
    }
  }

  // ----- harmful seed lessons point at real eval tasks that check their target -----
  for (const h of seed.harmful) {
    const triggers = h.triggerTasks ?? [];
    for (const id of triggers) {
      const t = taskById.get(id);
      if (!t) bad(`${h.id}: trigger task ${id} not found`);
      else {
        if (!t.checks.some((c) => c.name === h.targetAssertion)) bad(`${h.id}: ${id} has no ${h.targetAssertion} check`);
        if (!t.triggersHarmful?.includes(h.id)) bad(`${h.id}: ${id} doesn't list ${h.id} in triggers_harmful`);
      }
    }
    const evalTriggers = triggers.filter((id) => taskById.get(id)?.split === "eval").length;
    if (evalTriggers < 3) bad(`${h.id}: only ${evalTriggers} eval trigger tasks`);
  }
  for (const t of tasks) {
    for (const h of t.triggersHarmful ?? []) {
      const lesson = seed.harmful.find((x) => x.id === h);
      if (lesson && !lesson.triggerTasks?.includes(t.taskId)) bad(`${t.taskId}: lists ${h} but ${h}'s trigger_tasks don't include it`);
    }
  }
  const dataProblems = problems.length;

  // ----- scripted scenarios -----
  console.log("scripted scenarios:");
  let passed = 0;
  for (const sc of scenarios) {
    const t = taskById.get(sc.task);
    const snap = t && snapById.get(t.snapshotId);
    const errs: string[] = [];
    if (!t || !snap) errs.push("task or snapshot not found");
    else {
      const store = new Store(snap, t.faults);
      const shown = sc.steps.map(([tool, args]) => store.call(tool, args));
      const got = Object.fromEntries(check(t, store.state, store.log).map((a) => [a.name, a.passed]));
      const names = new Set([...Object.keys(got), ...Object.keys(sc.expect)]);
      for (const k of names) if (got[k] !== sc.expect[k]) errs.push(`${k}: expected ${sc.expect[k]}, got ${got[k]}`);
      const codes = store.log.map((c) => logCode(c.result));
      if (store.log.length !== sc.steps.length) errs.push(`log has ${store.log.length} entries for ${sc.steps.length} calls`);
      if (sc.log && codes.join(",") !== sc.log.join(",")) errs.push(`log [${codes}], expected [${sc.log}]`);
      for (const [i, want] of Object.entries(sc.shown ?? {})) {
        if (!partialMatch(shown[Number(i)], want)) errs.push(`step ${i} showed ${JSON.stringify(shown[Number(i)])}`);
      }
      const sum = summarize(store.state, t.orderId);
      for (const [k, v] of Object.entries(sc.summary ?? {})) if (sum[k] !== v) errs.push(`summary ${k} = ${sum[k]}, expected ${v}`);
    }
    if (errs.length) bad(`${sc.task} / ${sc.label}: ${errs.join("; ")}`);
    else passed++;
    console.log(`  ${errs.length ? "FAIL" : "ok  "} ${sc.task} / ${sc.label}${errs.length ? `\n       ${errs.join("\n       ")}` : ""}`);
  }

  // Runs must never change the loaded snapshot: every run starts from the same store.
  if (JSON.stringify(snapshots) !== pristine) bad("a store run mutated its snapshot");

  // ----- summary -----
  const count = <T>(xs: T[], key: (x: T) => string) =>
    Object.entries(xs.reduce<Record<string, number>>((m, x) => ((m[key(x)] = (m[key(x)] ?? 0) + 1), m), {}))
      .map(([k, n]) => `${k} ${n}`)
      .join(", ");
  const checks = tasks.flatMap((t) => t.checks ?? []);
  const withFaults = tasks.filter((t) => t.faults && Object.keys(t.faults).length);
  console.log(`\ntasks: ${tasks.length} (${count(tasks, (t) => t.split)}; ${count(tasks, (t) => t.workflow)})`);
  console.log(`checks: ${checks.length} (${count(checks, (c) => (c.type === "state" ? "state" : c.rule))})`);
  console.log(`faults: ${withFaults.length} tasks (${count(withFaults.flatMap((t) => Object.entries(t.faults ?? {})), ([k, v]) => `${k}:${v}`)})`);
  console.log(`snapshots: ${snapshots.map((s: Snapshot) => `${s.snapshotId} (${s.orders.length} orders, today ${s.today})`).join(", ")}`);
  console.log(`lesson seed: ${seed.useful.length} useful, ${seed.harmful.length} harmful; tools: ${config.tools.length}`);

  console.log(`\n${passed}/${scenarios.length} scenarios pass`);
  if (dataProblems) console.log(`${dataProblems} data problem(s)`);
  if (problems.length) {
    console.log(`\nPROBLEMS:\n  ${problems.join("\n  ")}`);
    process.exit(1);
  }
  console.log("all good");
}

main();
