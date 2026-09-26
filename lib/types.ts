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
  goodVersionId?: string; // a measured known-good version for its failing task, when the root isn't GOOD
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
  // Whose immune memory this is: "lab" (manual investigations) or an autopilot session id. Each
  // autopilot session's agent starts fresh and is guarded only by its own convictions.
  scope: string;
  investigationId: string; // the first conviction
  convictions: string[]; // every investigation that convicted this rule (one antibody per rule)
  convictedLessonId: string;
  lessonText: string;
  embedding: number[];
  failingTaskId: string;
  targetAssertion: string;
  evidence: { withFails: number; withoutFails: number; trials: number };
  repair: "removed" | "awaiting_decision";
  label: Origin; // origin of the convicted lesson, shown as-is
  createdAt: Date;
  recognitions: number;
  blocks: number;
}

// ---------- investigations (spec section 5) ----------

// One classified batch of fresh trials: a task on a version (or a configuration of it).
export interface Probe {
  key: string; // stable within the investigation, e.g. "search-v5", "verify-current_minus_suspect"
  phase: "endpoint" | "search" | "scan" | "verify" | "recheck" | "pinned" | "replay" | "gate" | "monitor";
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
  sessionId?: string; // the autopilot session that started it
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

// ---------- immune recognition (spec section 6.3) ----------

// One proposed rule checked against the antibodies. Similarity only picks which case to replay;
// the decision comes from fresh runs (Confirm on the antibody's failing case).
export interface Recognition {
  recognitionId: string; // "rec1", ...
  text: string;
  label: Origin;
  source: "immune_page" | "autopilot";
  sessionId?: string; // autopilot session
  baseVersionId: string;
  candidateVersionId: string | null; // base + the proposed lesson (only created when something matched)
  lessonId: string | null;
  threshold: number;
  matches: { antibodyId: string; score: number; lessonText: string }[]; // top 3 at or above the threshold
  replays: { antibodyId: string; score: number; probe: Probe }[];
  // Matches whose case the base agent already fails: a replay couldn't show this rule caused it.
  untestable: { antibodyId: string; score: number; baseLabel: Label }[];
  scope: string | null; // antibodies searched: one autopilot session, or null for all
  decision: "no_match" | "immune_blocked" | "immune_passed";
  blockedBy: string | null;
  ms: number; // proposal to decision
  runs: number;
  createdAt: Date;
}

// What GET /api/immune returns.
export interface ImmuneView {
  threshold: number | null; // null until calibrated: "Propose a rule" is disabled
  antibodies: (Omit<Antibody, "embedding"> & { firstCatch: { ms: number; runs: number; modelCalls: number } | null })[];
  pinnedCount: number; // distinct (task, assertion) pinned tests
  recognitions: Recognition[]; // newest first
  headline: {
    first: { investigationId: string; antibodyId: string; ms: number; runs: number } | null; // the investigation that convicted it
    repeat: { recognitionId: string; antibodyId: string; ms: number; runs: number; similarity: number } | null; // latest block
  };
  baseVersions: { versionId: string; label: string }[]; // choices for "Propose a rule", best first
  menu: { text: string; kind: "reworded bad rule" | "useful rule" }[]; // prewritten rules for "Propose a rule"
}

// ---------- autopilot (spec section 7) ----------

export type AutopilotEventType =
  | "session_started"
  | "training_run"
  | "no_proposal"
  | "proposed"
  | "immune_blocked"
  | "immune_passed"
  | "immune_no_match"
  | "immune_skipped"
  | "gate_passed"
  | "gate_rejected"
  | "activated"
  | "monitor_ok"
  | "false_alarm"
  | "regression_confirmed"
  | "investigation_started"
  | "antibody_created"
  | "repair_activated"
  | "awaiting_decision"
  | "decision"
  | "budget_stop"
  | "insufficient_evidence"
  | "session_done";

// A compact probe for the timeline: what ran, on which version, and what it showed.
export interface EvidenceItem {
  taskId: string;
  versionId: string;
  kind: "trigger" | "gate" | "pinned" | "monitor" | "baseline" | "replay";
  status?: "ok" | "fail" | "insufficient_evidence"; // screens (2 trials)
  label?: Label; // confirms (5 trials)
  counts: Counts;
  trials: number;
  runIds: string[];
}

export interface AutopilotEvent {
  key: string; // unique within the session, so a retried step never logs an event twice
  seq: number;
  at: Date;
  type: AutopilotEventType;
  msg: string;
  label?: Origin;
  text?: string; // the proposed rule
  taskId?: string;
  versionId?: string;
  lessonId?: string;
  recognitionId?: string;
  investigationId?: string;
  antibodyId?: string;
  evidence?: EvidenceItem[];
  runIds?: string[]; // runs behind a training_run event
  runs?: number;
  ms?: number;
}

// The request stream: training requests plus the fixed, labelled demo branch.
export type StreamItem =
  | { kind: "training"; taskId: string }
  | { kind: "planted"; seedId: string; text: string; note: string } // submitted through the gate
  | { kind: "injected"; seedId: string; text: string; note: string } // bypasses the gate (labelled so)
  | { kind: "reworded"; seedId: string; text: string; note: string } // a rewording of a convicted rule, through the gate
  | { kind: "monitor"; note: string }; // a scheduled monitoring check

export interface AutopilotSession {
  sessionId: string; // "ap1", ...
  status: "running" | "awaiting_decision" | "done" | "stopped" | "error";
  historyId: string; // the line of activated versions
  startVersionId: string;
  activeVersionId: string;
  candidateVersionId: string | null; // at most one
  stream: StreamItem[];
  position: number; // next stream item
  sets: { gate: string[]; monitoring: string[] };
  status0: Record<string, "GOOD" | "not_good">; // gate/monitoring task status on the active version ("previously GOOD")
  activations: number;
  activationsAtLastMonitor: number;
  lastMonitorOkVersionId: string;
  pendingRepair: { investigationId: string; repairVersionId: string } | null; // waiting for Approve / Reject
  decision: "approve" | "reject" | null;
  events: AutopilotEvent[];
  workflowRunId?: string;
  createdAt: Date;
  finishedAt?: Date;
}

// What GET /api/autopilot/[id] returns.
export interface AutopilotView {
  session: AutopilotSession;
  cost: Cost; // the session's own runs (screens, confirms, training runs)
  immuneCost: Cost; // recognition replays started by this session
  lessons: Record<string, { text: string; origin: Origin }>; // lessons on the session's versions
  activeLessonIds: string[];
  elapsedMs: number;
}
