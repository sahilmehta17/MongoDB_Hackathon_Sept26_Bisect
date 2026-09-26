// Plain-code checker: each task check is either an expression over the final store summary
// (lib/store/sim.ts summarize) or a rule over the tool-call log. No model judgment anywhere.
// A check that can't be evaluated (unknown field or rule, malformed expression) throws: that is
// a bug in data/tasks.yaml, never something the agent did.
import { MUTATING_TOOLS, summarize, type StoreState } from "@/lib/store/sim";
import type { Assertion, Task, TaskCheck, ToolCall } from "@/lib/types";

export const CHECKER_VERSION = "checker-v1";

export function check(task: Task, state: StoreState, log: ToolCall[]): Assertion[] {
  const vars = summarize(state, task.orderId);
  return task.checks.map((c) => ({ name: c.name, passed: runCheck(task, c, vars, log) }));
}

function runCheck(task: Task, c: TaskCheck, vars: Record<string, number | boolean>, log: ToolCall[]): boolean {
  if (c.type === "state") return evalExpr(c.expr, vars);
  const rule = TOOL_LOG_RULES[c.rule];
  if (!rule) throw new Error(`unknown tool_log rule "${c.rule}" in ${task.taskId}`);
  return rule(log);
}

// Error message for a check that could never be evaluated, or null. Doesn't need a store run.
export function validateCheck(c: TaskCheck, knownFields: string[]): string | null {
  if (c.type === "tool_log") return c.rule in TOOL_LOG_RULES ? null : `unknown tool_log rule "${c.rule}"`;
  if (c.type !== "state") return `unknown check type "${(c as { type: unknown }).type}"`;
  try {
    parseExpr(c.expr, new Set(knownFields));
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

// ---------- state expressions ----------
// Grammar:  or  := and ("||" and)*
//           and := cmp ("&&" cmp)*
//           cmp := "(" or ")" | value OP value      OP: == != <= >= < >
//           value := number | true | false | field
// Every leaf is a comparison, so a bare field or literal is rejected as malformed.

type Value = { kind: "num"; v: number } | { kind: "bool"; v: boolean } | { kind: "field"; name: string };
type CmpOp = "==" | "!=" | "<=" | ">=" | "<" | ">";
type Node =
  | { kind: "logic"; op: "&&" | "||"; left: Node; right: Node }
  | { kind: "cmp"; op: CmpOp; left: Value; right: Value };

const TOKEN = /\s*(?:(-?\d+(?:\.\d+)?)|([A-Za-z_]\w*)|(==|!=|<=|>=|&&|\|\||[<>()]))/y;
const CMP_OPS = new Set(["==", "!=", "<=", ">=", "<", ">"]);

function tokenize(expr: string): string[] {
  const out: string[] = [];
  TOKEN.lastIndex = 0;
  while (TOKEN.lastIndex < expr.length) {
    if (!expr.slice(TOKEN.lastIndex).trim()) break;
    const at = TOKEN.lastIndex;
    const m = TOKEN.exec(expr);
    if (!m) throw new Error(`unexpected "${expr.slice(at).trim()[0]}" at ${at} in "${expr}"`);
    out.push(m[1] ?? m[2] ?? m[3]);
  }
  return out;
}

function parseExpr(expr: string, fields: Set<string>): Node {
  const toks = tokenize(expr);
  let i = 0;
  const fail = (msg: string): never => {
    throw new Error(`${msg} in "${expr}"`);
  };
  const peek = () => toks[i];
  const take = (t: string) => {
    if (toks[i] !== t) return false;
    i++;
    return true;
  };

  const value = (): Value => {
    const t = toks[i++];
    if (t === undefined) return fail("expression ends early");
    if (t === "true" || t === "false") return { kind: "bool", v: t === "true" };
    if (/^-?\d/.test(t)) return { kind: "num", v: Number(t) };
    if (/^[A-Za-z_]/.test(t)) {
      if (!fields.has(t)) fail(`unknown field "${t}"`);
      return { kind: "field", name: t };
    }
    return fail(`expected a value, got "${t}"`);
  };
  const cmp = (): Node => {
    if (take("(")) {
      const inner = or();
      if (!take(")")) fail("missing )");
      return inner;
    }
    const left = value();
    const op = peek();
    if (!CMP_OPS.has(op)) fail(op === undefined ? "missing comparison" : `expected a comparison, got "${op}"`);
    i++;
    return { kind: "cmp", op: op as CmpOp, left, right: value() };
  };
  const and = (): Node => {
    let node = cmp();
    while (take("&&")) node = { kind: "logic", op: "&&", left: node, right: cmp() };
    return node;
  };
  const or = (): Node => {
    let node = and();
    while (take("||")) node = { kind: "logic", op: "||", left: node, right: and() };
    return node;
  };

  if (!toks.length) fail("empty expression");
  const root = or();
  if (i < toks.length) fail(`unexpected "${toks[i]}"`);
  return root;
}

export function evalExpr(expr: string, vars: Record<string, number | boolean>): boolean {
  return evalNode(parseExpr(expr, new Set(Object.keys(vars))), vars, expr);
}

function evalNode(n: Node, vars: Record<string, number | boolean>, expr: string): boolean {
  if (n.kind === "logic") {
    const left = evalNode(n.left, vars, expr);
    // Short-circuits like the language would; fields were already checked when parsing.
    if (n.op === "&&" ? !left : left) return left;
    return evalNode(n.right, vars, expr);
  }
  const get = (v: Value) => (v.kind === "field" ? vars[v.name] : v.v);
  return compare(get(n.left), n.op, get(n.right), expr);
}

// Money is rounded to cents, so numbers within half a cent are equal.
const EPS = 0.005;

function compare(l: number | boolean, op: CmpOp, r: number | boolean, expr: string): boolean {
  if (typeof l === "boolean" || typeof r === "boolean") {
    if (op === "==") return l === r;
    if (op === "!=") return l !== r;
    throw new Error(`cannot use ${op} on a true/false value in "${expr}"`);
  }
  switch (op) {
    case "==":
      return Math.abs(l - r) < EPS;
    case "!=":
      return Math.abs(l - r) >= EPS;
    case "<=":
      return l <= r + EPS;
    case ">=":
      return l >= r - EPS;
    case "<":
      return l < r - EPS;
    case ">":
      return l > r + EPS;
  }
}

// ---------- tool-log rules ----------

const isTimeout = (c: ToolCall) =>
  c.result === "timeout" || (typeof c.result === "object" && c.result !== null && (c.result as { error?: unknown }).error === "timeout");

export const TOOL_LOG_RULES: Record<string, (log: ToolCall[]) => boolean> = {
  // After every issue_refund timeout, get_payment_status is called before any further refund.
  called_after_timeout: (log) =>
    log.every((c, i) => {
      if (c.tool !== "issue_refund" || !isTimeout(c)) return true;
      const rest = log.slice(i + 1);
      const status = rest.findIndex((x) => x.tool === "get_payment_status");
      const refund = rest.findIndex((x) => x.tool === "issue_refund");
      return status !== -1 && (refund === -1 || status < refund);
    }),
  // After the first get_order timeout, a later get_order call gets through (vacuously true without one).
  retried_after_lookup_timeout: (log) => {
    const i = log.findIndex((c) => c.tool === "get_order" && isTimeout(c));
    return i === -1 || log.slice(i + 1).some((c) => c.tool === "get_order" && !isTimeout(c));
  },
  // An order lookup that got through came before the first change to the store.
  looked_up_order_first: (log) => {
    const firstChange = log.findIndex((c) => MUTATING_TOOLS.has(c.tool));
    return firstChange === -1 || log.slice(0, firstChange).some((c) => c.tool === "get_order" && !isTimeout(c));
  },
  // A replacement was attempted, and before any refund.
  tried_replacement_first: (log) => {
    const rep = log.findIndex((c) => c.tool === "ship_replacement");
    const ref = log.findIndex((c) => c.tool === "issue_refund");
    return rep !== -1 && (ref === -1 || rep < ref);
  },
};
