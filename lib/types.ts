// Shared data shapes. Stored in MongoDB as written here (camelCase).

// Where a lesson came from. natural: the agent wrote it; seeded: hand-written useful lesson;
// planted: hand-written harmful lesson submitted through the gate; injected: harmful lesson that
// bypassed the gate; visitor: submitted on /immune by a person.
export type Origin = "seeded" | "natural" | "planted" | "injected" | "visitor";
export type Label = "GOOD" | "BAD" | "INCONCLUSIVE";
export type Outcome = "pass" | "target_fail" | "other_fail" | "error";
export type ContextMode = "normal" | "frozen_minus_suspect";

// ---------- tasks and store data (data/*.yaml, camelCased on load) ----------

export type Workflow = "refund" | "replacement" | "address" | "store_credit";

export type TaskCheck =
  | { name: string; type: "state"; expr: string }
  | { name: string; type: "tool_log"; rule: string };

export interface Task {
  taskId: string;
  split: "training" | "eval";
  workflow: Workflow;
  request: string;
  snapshotId: string;
  orderId?: string;
  faults?: Record<string, string>; // tool name -> fault, e.g. { issue_refund: "timeout_after_commit" }
  checks: TaskCheck[];
  feedbackOnFail?: string;
  triggersHarmful?: string[]; // e.g. ["H1"]
  embedding?: number[];
}

export interface Item {
  itemId: string;
  name: string;
  price: number;
  damaged?: boolean;
}

export interface Order {
  orderId: string;
  customer: { customerId: string; name: string; email: string; tier: "standard" | "vip" };
  orderDate: string; // YYYY-MM-DD
  shipped: boolean;
  shippingAddress: string;
  verificationCode: string; // never shown to the agent
  items: Item[];
  payment: { amountPaid: number; amountRefunded: number; refundCount: number };
}

export interface Snapshot {
  snapshotId: string;
  today: string; // fixed date so day counts never depend on the clock
  orders: Order[];
  inventory?: Record<string, number>; // item id -> units in stock
}

export interface ToolSchema {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

// Prompts, tool schemas and house rules (data/prompts.yaml, tools.yaml, house_rules.yaml).
export interface AgentConfig {
  agentSystem: string[]; // lines; "{today}" is replaced with the snapshot date
  lessonsHeader: string;
  midrunLessonsHeader: string;
  reflectSystem: string;
  tools: ToolSchema[];
  houseRules: Record<string, { text: string; wrong: string }>; // keyed by assertion name
}

// ---------- store run results ----------

export interface ToolCall {
  tool: string;
  args: Record<string, unknown>;
  result: unknown; // "timeout", "ok", or a JSON payload
}

export interface Assertion {
  name: string;
  passed: boolean;
}

// ---------- lessons, versions, histories ----------

export interface Lesson {
  lessonId: string; // "L1", "L2", ...
  text: string;
  origin: Origin;
  seedId?: string; // "U3", "H1", ... when it came from data/lessons_seed.yaml
  sourceRunId: string | null;
  parentLessonIds: string[];
  createdAt: Date;
  embedding?: number[];
  score?: number; // set by retrieval
}

export type VersionStatus = "active" | "candidate" | "rejected";

// Immutable: each version is its parent plus exactly one change (or the empty root).
export interface Version {
  versionId: string; // "v1", "v2", ...
  historyId: string;
  index: number; // position in the history line (0 = root)
  parentVersionId: string | null;
  activeLessonIds: string[]; // the effective set; retrieval reads only this
  change: { op: "add" | "remove"; lessonId: string } | null;
  label?: Origin; // origin of the lesson this version added or removed
  status: VersionStatus;
  createdBy: "seed" | "learning" | "bisect" | "autopilot" | "immune";
  note?: string;
  investigationId?: string;
  createdAt: Date;
}

// A line of versions, plus the known right answer when it was built on purpose.
export interface History {
  historyId: string; // "h1", ...
  versionIds: string[]; // in order, root first
  groundTruth?: {
    seedId: string; // e.g. "H1"
    lessonId: string;
    versionId: string; // the version that added it
    failingTaskId: string;
    targetAssertion: string;
  };
  note?: string;
  createdAt: Date;
}

// ---------- run record ----------

export interface RetrievedLesson {
  id: string;
  text: string;
  rank: number;
  trigger?: string; // set when looked up mid-run, e.g. "issue_refund timed out"
}

export interface TranscriptMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  toolCalls?: { id: string; name: string; arguments: string }[];
  toolCallId?: string;
  midRun?: boolean; // a system message added during the run (lesson reminder after a failure)
}

export interface RunRecord {
  runId: string; // fixed by the caller, e.g. "inv3-p2-t4"; saving is an upsert on it
  taskId: string;
  versionId: string;
  trial: number;
  snapshotId: string;
  toolCodeVersion: string;
  checkerVersion: string;
  model: { name: string; temperature: number; maxTokens: number };
  contextMode: ContextMode;
  activeLessonIds: string[];
  retrievedLessons: RetrievedLesson[];
  renderedPromptHash: string;
  toolCalls: ToolCall[];
  toolSteps: number;
  finalStateSummary: Record<string, unknown>;
  assertions: Assertion[];
  targetAssertion: string | null;
  outcome: Outcome | null; // set when a target assertion is given
  error: string | null;
  infraRetries: number;
  tokens: number;
  modelCalls: number;
  transcript: TranscriptMessage[];
  createdAt: Date;
}

export interface RunTaskOpts {
  taskId: string;
  versionId: string;
  trial: number;
  runId: string;
  contextMode?: ContextMode;
  frozenLessonIds?: string[]; // required for frozen_minus_suspect: the only lessons that can appear
  targetAssertion?: string;
}

// ---------- evidence (spec section 4) ----------

export interface Counts {
  pass: number;
  targetFail: number;
  otherFail: number;
  error: number;
}

export const LIMITS = {
  screenTrials: 2,
  confirmTrials: 5,
  maxInfraRetries: 2, // per trial
  maxToolCalls: 12, // per run
  maxRuns: 300, // per investigation
  maxModelCalls: 1500, // per investigation
  concurrency: 5, // parallel trials
  recheckMax: 16,
  recheckBatch: 3,
} as const;

// Run budget for one investigation or autopilot session: reserved atomically before runs start.
export interface Budget {
  _id: string; // owner id, e.g. "inv3"
  maxRuns: number;
  maxModelCalls: number;
  reservedRuns: number;
  usedRuns: number;
  modelCalls: number;
  tokens: number;
}

// ---------- immune memory (spec section 6) ----------

export interface Antibody {
  antibodyId: string; // "ab1", ...
  investigationId: string;
  convictedLessonId: string;
  lessonText: string;
  embedding: number[];
  failingTaskId: string;
  targetAssertion: string;
  evidence: { withFails: number; withoutFails: number; trials: number };
  repair: "removed" | "awaiting_decision";
  label: "natural" | "planted" | "injected";
  createdAt: Date;
  recognitions: number;
  blocks: number;
}

// ---------- investigations (spec section 5) ----------

// One classified batch of fresh trials: a task on a version (or a configuration of it).
export interface Probe {
  key: string; // stable within the investigation, e.g. "search-v5", "verify-current_minus_suspect"
  phase: "endpoint" | "search" | "scan" | "verify" | "recheck" | "pinned";
  config?: "parent" | "introducing" | "current" | "current_minus_suspect" | "before" | "after";
  versionId: string;
  versionIndex: number;
  taskId: string;
  contextMode: ContextMode;
  label: Label;
  counts: Counts;
  trials: number;
  runIds: string[];
}

// One re-check task: the current version (before) vs the repair (after), normal retrieval.
export interface RecheckRow {
  taskId: string;
  reason: string;
  before: Probe;
  after: Probe;
}

export type Verdict = "running" | "verified" | "inconclusive" | "baseline_not_reproduced" | "budget_exceeded" | "error";

export interface Investigation {
  investigationId: string; // "inv1", ...
  historyId: string;
  trigger: "manual" | "monitor" | "autopilot";
  failureTaskId: string;
  targetAssertion: string;
  goodVersionId: string;
  badVersionId: string;
  line: { versionId: string; index: number; lessonId: string | null }[]; // the searched segment, good..bad
  probes: Probe[]; // endpoint, search and scan probes
  suspect: { lessonId: string; versionId: string; text: string; origin: Origin } | null;
  verification: Probe[]; // the four configurations
  repairVersionId: string | null;
  recheckTaskIds?: string[]; // frozen once built
  recheckReasons?: Record<string, string>;
  recheck: RecheckRow[];
  pinned: RecheckRow[]; // pinned tests from antibodies, screened on the repair
  acceptance: "accepted" | "awaiting_decision" | null;
  broken: string[]; // previously GOOD tasks that are no longer GOOD on the repair
  antibodyId: string | null;
  verdict: Verdict;
  summary?: string;
  workflowRunId?: string;
  startedAt: Date;
  finishedAt?: Date;
  log: { at: Date; msg: string }[];
}

// Cost, always derived from the saved run records (so a retried step can never double-count).
export interface Cost {
  runs: number;
  modelCalls: number;
  tokens: number;
  errors: number;
}

// What GET /api/investigations/[id] returns: the investigation plus what the page needs to explain it.
export interface InvestigationView {
  investigation: Investigation;
  cost: Cost;
  elapsedMs: number;
  lessons: Record<string, { text: string; origin: Origin; seedId?: string }>; // every lesson on the searched line
  tasks: Record<string, { request: string; workflow: Workflow }>; // failing task + re-check tasks
  houseRules: AgentConfig["houseRules"];
  groundTruth: History["groundTruth"] | null; // the planted answer, when the history was built on purpose
}
