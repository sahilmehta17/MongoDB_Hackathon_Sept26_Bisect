// Turns one autopilot session into the story shown on /autopilot/[id]: one row per rule and per
// notable moment, in the order they happened (UI spec §5). Pure: reads the view, never the database.
import { LIMITS, type AutopilotEvent, type AutopilotView, type EvidenceItem, type InvestigationView, type Origin, type Recognition } from "@/lib/types";

export type StoryStep = "learn" | "test" | "watch" | "diagnose" | "remember";
export const STEPS: { id: StoryStep; label: string }[] = [
  { id: "learn", label: "Learn" },
  { id: "test", label: "Test" },
  { id: "watch", label: "Watch" },
  { id: "diagnose", label: "Diagnose" },
  { id: "remember", label: "Remember" },
];

export type RowKind =
  | "routine"
  | "accepted"
  | "live"
  | "blocked_tests"
  | "blocked_memory"
  | "alarm"
  | "bisect"
  | "remembered"
  | "needs_person"
  | "undecided";

export interface StoryLink {
  label: string;
  href: string;
}

export interface StoryRow {
  key: string;
  kind: RowKind;
  step: StoryStep;
  chip: "planted" | "injected" | "visitor" | null;
  line1: string; // the sentence (rule text shortened to ~90 characters)
  line2: string[]; // the outcome, 0-3 short lines
  expand: string[]; // the proof, at most 3 lines
  small?: string; // sample size note shown when expanded, e.g. "(5 fresh runs)"
  links: StoryLink[];
  items?: { title: string; outcome: string; href?: string }[]; // routine rows: what was handled
  open: boolean; // expanded by default
  numbers?: { seconds: number; runs: number }; // Bisect and immune-block rows feed the header
  decision?: { investigationId: string; repairVersionId: string }; // needs_person rows
}

export interface Story {
  status: "running" | "finished" | "waiting" | "stopped";
  start: string;
  rows: StoryRow[];
  header: {
    firstCatch: { seconds: number; runs: number; href: string } | null;
    repeatCatch: { seconds: number; runs: number } | null;
    remembered: number;
  };
  footer: {
    seconds: number;
    plan: string[];
    startLessons: string[];
    gate: string[];
    monitoring: string[];
  };
}

// ---------- plain words ----------

// What each kind of request is, keyed by task-id prefix (task ids end in _tNN or _NN).
const TASK_TITLES: Record<string, string> = {
  refund_basic: "a normal refund",
  refund_large: "a large refund that needs review",
  refund_late: "a late return",
  refund_vip_late: "a VIP customer's late return",
  refund_prior: "an order that was already partly refunded",
  refund_lookup_timeout: "a refund where the order lookup times out",
  refund_partial: "a partial return",
  refund_timeout: "a refund that times out after going through",
  refund_loyal_late: "a late return from a customer who says they're loyal",
  replace_damaged: "a damaged item",
  replace_oos: "an out-of-stock refund",
  address_verified: "an address change with the right code",
  address_unverified: "an address change without the code",
  address_unshipped: "an address change before shipping",
  address_email: "an address change from the account email",
  credit: "a store-credit request",
};
// The same requests, worded to follow "it broke …".
const BROKE: Record<string, string> = {
  refund_basic: "a normal refund",
  refund_large: "the review of large refunds",
  refund_late: "the return window",
  refund_vip_late: "VIP returns",
  refund_prior: "refunds on partly refunded orders",
  refund_lookup_timeout: "refunds where the lookup times out",
  refund_partial: "partial returns",
  refund_timeout: "the one-refund rule",
  refund_loyal_late: "the return window",
  replace_damaged: "damaged-item replacements",
  replace_oos: "an out-of-stock refund",
  address_verified: "address changes with the right code",
  address_unverified: "the verification-code rule",
  address_unshipped: "address changes before shipping",
  address_email: "the verification-code rule",
  credit: "the store-credit amount",
};
const kind = (taskId: string) => taskId.replace(/_t?\d+$/, "");
export const taskTitle = (taskId: string) => TASK_TITLES[kind(taskId)] ?? "another request";
export const brokeTitle = (taskId: string) => BROKE[kind(taskId)] ?? "a task that passed before";

// What the harm is called, by the house rule's check.
const HARM: Record<string, string> = {
  no_duplicate_refund: "double refunds",
  within_return_window: "late refunds",
  verification_required: "unverified address changes",
  large_refund_escalated: "unreviewed large refunds",
  damaged_gets_replacement: "refunds instead of replacements",
  store_credit_amount: "wrong credit amounts",
  no_over_refund: "over-refunds",
  refund_issued: "missed refunds",
  correct_amount: "wrong refund amounts",
};

// The harm as a noun phrase, e.g. "double refunds" (null for checks without one).
export const harmOf = (assertion: string): string | null => HARM[assertion] ?? null;

// Shorten at a word boundary so a rule fits on one projector line; the full text is in the expand.
export function shorten(text: string, max = 80): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.]+$/, "")}…`;
}
const q = (text: string, max = 80) => `“${shorten(text, max)}”`;
const secs = (ms: number) => Math.round(ms / 100) / 10;
const run = (id?: string): StoryLink[] => (id ? [{ label: "See the trace", href: `/runs/${id}` }] : []);
const chipOf = (label?: string): StoryRow["chip"] => (label === "planted" || label === "injected" || label === "visitor" ? label : null);

export function formatDuration(seconds: number): string {
  const s = Math.round(seconds);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
}

// Short times read better as seconds (e.g. "63 s"); longer ones as minutes and seconds.
export const shortDuration = (seconds: number) => (seconds < 120 ? `${Math.round(seconds)} s` : formatDuration(seconds));

// The confirm or screen that decided a gate rejection: the first non-passing confirm, else a trigger.
function deciding(evidence: EvidenceItem[] = []): EvidenceItem | undefined {
  return (
    evidence.find((e) => e.label && e.label !== "GOOD" && e.kind !== "trigger") ??
    evidence.find((e) => e.kind === "trigger" && e.label && e.label !== "GOOD") ??
    evidence.find((e) => e.status && e.status !== "ok")
  );
}

// ---------- the story ----------

export function toStory(view: AutopilotView): Story {
  const s = view.session;
  const events = [...s.events].sort((a, b) => a.seq - b.seq);
  const recs = new Map((view.recognitions ?? []).map((r) => [r.recognitionId, r]));
  const invs = new Map((view.investigations ?? []).map((i) => [i.investigation.investigationId, i]));
  const rules = view.houseRules ?? {};
  const rows: StoryRow[] = [];
  const plan: string[] = [];
  let start = "";

  // Routine events collapse: all routine requests into one row, and all-clear monitoring checks
  // into one row, each placed where the first one happened; expanding lists them in order.
  const routineRows: Partial<Record<"requests" | "monitoring", StoryRow>> = {};
  const flush = () => {};
  const addRoutine = (kind: "requests" | "monitoring", key: string, item: NonNullable<StoryRow["items"]>[number]) => {
    let row = routineRows[kind];
    if (!row) {
      row = { key, kind: "routine", step: kind === "requests" ? "learn" : "watch", chip: null, line1: "", line2: [], expand: [], links: [], items: [], open: false };
      routineRows[kind] = row;
      rows.push(row);
    }
    row.items!.push(item);
    const n = row.items!.length;
    row.line1 = kind === "requests" ? `${n} routine request${n === 1 ? "" : "s"} handled along the way` : "Monitoring: all clear";
  };

  let proposal: { proposed: AutopilotEvent; failedRun?: AutopilotEvent; steps: AutopilotEvent[] } | null = null;
  let pendingFailure: AutopilotEvent | undefined;
  let bisect: { started: AutopilotEvent; antibody?: AutopilotEvent } | null = null;

  const closeProposal = (terminal: AutopilotEvent) => {
    if (!proposal) return;
    rows.push(proposalRow(proposal.proposed, proposal.failedRun, proposal.steps, terminal, recs, plan));
    proposal = null;
  };
  const closeBisect = () => {
    if (!bisect) return;
    const inv = bisect.started.investigationId ? invs.get(bisect.started.investigationId) : undefined;
    const row = bisectRow(bisect.started, inv);
    if (row) rows.push(row);
    if (bisect.antibody) {
      rows.push({
        key: bisect.antibody.key,
        kind: "remembered",
        step: "remember",
        chip: null,
        line1: "Remembered it",
        line2: [],
        expand: ["From now on, any new rule that looks like this gets its old failing case replayed first."],
        links: [{ label: "See the memory", href: "/immune" }],
        open: false,
      });
    }
    bisect = null;
  };

  for (const e of events) {
    switch (e.type) {
      case "session_started": {
        if (e.key === "plan") {
          plan.push(...e.msg.split(" · ").map((x) => x.trim()).filter(Boolean));
        } else {
          const ev = e.evidence ?? [];
          const ok = ev.filter((x) => x.status === "ok").length;
          const n = view.startLessons?.length ?? 0;
          const rulesPart = n ? `Started with ${n} hand-written rule${n === 1 ? "" : "s"}.` : "Started with no rules.";
          start = `${rulesPart} ${ok === ev.length ? `All ${ev.length} test tasks pass.` : `${ok} of ${ev.length} test tasks pass.`}`;
        }
        break;
      }
      case "training_run": {
        const passed = !e.msg.includes(" failed ");
        if (passed) addRoutine("requests", e.key, { title: taskTitle(e.taskId ?? ""), outcome: "handled correctly", href: e.runIds?.[0] ? `/runs/${e.runIds[0]}` : undefined });
        else pendingFailure = e;
        break;
      }
      case "no_proposal":
        addRoutine("requests", e.key, {
          title: taskTitle(e.taskId ?? pendingFailure?.taskId ?? ""),
          outcome: "handled wrongly; no rule learned",
          href: pendingFailure?.runIds?.[0] ? `/runs/${pendingFailure.runIds[0]}` : undefined,
        });
        pendingFailure = undefined;
        break;
      case "proposed":
        flush();
        proposal = { proposed: e, failedRun: pendingFailure, steps: [] };
        pendingFailure = undefined;
        break;
      case "immune_no_match":
      case "immune_passed":
      case "immune_skipped":
      case "gate_passed":
        proposal?.steps.push(e);
        break;
      case "gate_rejected":
      case "immune_blocked":
      case "activated":
        if (proposal) closeProposal(e);
        break;
      case "monitor_ok":
      case "false_alarm":
        addRoutine("monitoring", e.key, { title: "monitoring check", outcome: e.type === "false_alarm" ? "a false alarm, confirmed fine" : "all clear" });
        break;
      case "regression_confirmed": {
        flush();
        const next = events.find((x) => x.seq > e.seq && x.type === "investigation_started");
        const target = (next?.investigationId && invs.get(next.investigationId)?.investigation.targetAssertion) ?? "";
        const bad = (e.evidence ?? []).find((x) => x.label === "BAD");
        rows.push({
          key: e.key,
          kind: "alarm",
          step: "watch",
          chip: null,
          line1: `Monitoring: ${rules[target]?.wrong ? `the agent ${rules[target].wrong}` : `${taskTitle(e.taskId ?? "")} is failing`}`,
          line2: bad ? [`(${bad.counts.targetFail} of ${bad.trials} fresh runs)`] : [],
          expand: [`On ${taskTitle(e.taskId ?? bad?.taskId ?? "")}, which passed before.`],
          small: "(quick check, 2 runs, then 5 fresh runs)",
          links: run(bad?.runIds[0]),
          open: false,
        });
        break;
      }
      case "investigation_started":
        flush();
        bisect = { started: e };
        break;
      case "antibody_created":
        if (bisect) bisect.antibody = e;
        break;
      case "repair_activated":
        closeBisect();
        break;
      case "awaiting_decision": {
        const inv = e.investigationId ? invs.get(e.investigationId) : undefined;
        closeBisect();
        const broken = inv?.investigation.broken.length ?? 0;
        rows.push({
          key: e.key,
          kind: "needs_person",
          step: "diagnose",
          chip: null,
          line1: broken
            ? `Bisect found the rule, but removing it would break ${broken} other task${broken === 1 ? "" : "s"}`
            : "Bisect found the rule, but the fix needs a person to decide",
          line2: [],
          expand: [],
          links: e.investigationId ? [{ label: "See the full investigation", href: `/investigations/${e.investigationId}` }] : [],
          open: true,
          decision: e.investigationId && e.versionId ? { investigationId: e.investigationId, repairVersionId: e.versionId } : undefined,
        });
        break;
      }
      case "insufficient_evidence":
      case "budget_stop": {
        closeBisect();
        flush();
        const reason = e.type === "budget_stop" ? "the run budget ran out" : e.investigationId ? "the investigation couldn't pin it down" : "the results were mixed";
        rows.push({
          key: e.key,
          kind: "undecided",
          step: e.investigationId ? "diagnose" : "watch",
          chip: null,
          line1: `Not enough evidence to decide (${reason})`,
          line2: [],
          expand: [],
          links: e.investigationId ? [{ label: "See the full investigation", href: `/investigations/${e.investigationId}` }] : [],
          open: false,
        });
        break;
      }
      default:
        break;
    }
  }
  closeBisect();
  flush();

  const firstBisect = rows.find((r) => r.kind === "bisect" && r.numbers);
  const block = rows.find((r) => r.kind === "blocked_memory" && r.numbers);
  const firstInv = firstBisect?.links.find((l) => l.href.startsWith("/investigations/"));
  return {
    status: s.status === "done" ? "finished" : s.status === "awaiting_decision" ? "waiting" : s.status === "running" ? "running" : "stopped",
    start,
    rows,
    header: {
      firstCatch: firstBisect?.numbers ? { ...firstBisect.numbers, href: firstInv?.href ?? "/immune" } : null,
      repeatCatch: firstBisect && block?.numbers ? block.numbers : null,
      remembered: rows.filter((r) => r.kind === "remembered").length,
    },
    footer: {
      seconds: Math.round(view.elapsedMs / 1000),
      plan,
      startLessons: (view.startLessons ?? []).map((l) => l.text),
      gate: s.sets.gate.map(taskTitle),
      monitoring: s.sets.monitoring.map(taskTitle),
    },
  };
}

function proposalRow(
  proposed: AutopilotEvent,
  failedRun: AutopilotEvent | undefined,
  steps: AutopilotEvent[],
  terminal: AutopilotEvent,
  recs: Map<string, Recognition>,
  plan: string[],
): StoryRow {
  const text = proposed.text ?? "";
  const label = proposed.label;
  const chip = chipOf(label);
  const own = label === "natural";
  const base = { key: proposed.key, chip, links: [] as StoryLink[] };
  const passedMemory = steps.find((x) => x.type === "immune_passed" && x.recognitionId);
  const memoryNote = (() => {
    const r = passedMemory?.recognitionId ? recs.get(passedMemory.recognitionId) : undefined;
    const top = r?.replays[0] ?? r?.untestable[0];
    return top ? `Looked like a remembered rule (${Math.round(top.score * 100)}%), but passed its replay, so it went on to the tests.` : null;
  })();

  if (terminal.type === "immune_blocked") {
    const r = terminal.recognitionId ? recs.get(terminal.recognitionId) : undefined;
    const rep = r?.replays.find((x) => x.antibodyId === r.blockedBy) ?? r?.replays[0];
    const matched = r?.matches.find((m) => m.antibodyId === rep?.antibodyId);
    const seconds = secs(terminal.ms ?? r?.ms ?? 0);
    return {
      ...base,
      kind: "blocked_memory",
      step: "remember",
      line1: label === "visitor" ? `A visitor tried: ${q(text, 110)}` : `The agent tried again in new words: ${q(text, 110)}`,
      line2: rep
        ? [`Recognized (${Math.round(rep.score * 100)}% similar) → replayed the old case: ${rep.probe.counts.targetFail} of ${rep.probe.trials} → blocked in ${seconds} s`]
        : [`Blocked in ${seconds} s`],
      expand: [
        ...(matched ? [`It matched a rule caught earlier: ${q(matched.lessonText, 50)}`] : []),
        ...(text.length > 110 ? [`Full rule: “${text}”`] : []),
      ],
      small: "(5 fresh runs)",
      links: run(rep?.probe.runIds[0]),
      open: true,
      numbers: { seconds, runs: terminal.runs ?? r?.runs ?? 0 },
    };
  }

  if (terminal.type === "gate_rejected") {
    const gate = steps.find((x) => x.type === "gate_rejected") ?? terminal;
    const d = deciding(gate.evidence);
    const trigger = d?.kind === "trigger";
    const x = d?.counts.targetFail ?? 0;
    const n = d?.trials ?? 5;
    return {
      ...base,
      kind: "blocked_tests",
      step: "test",
      line1: own ? `The agent's own rule: ${q(text, 58)}` : q(text, 72),
      line2: [
        trigger
          ? `Blocked by tests: it didn't fix the request it was learned from (${n - (d?.counts.pass ?? 0)} of ${n} fresh runs still failed)`
          : `Blocked by tests: it broke ${d ? brokeTitle(d.taskId) : "a task that passed before"} (${x} of ${n} fresh runs)`,
      ],
      expand: [
        ...(memoryNote ? [memoryNote] : []),
        ...(d && !trigger ? [`${cap(taskTitle(d.taskId))} passed before this rule; with it, ${x} of ${n} fresh runs failed.`] : []),
        ...(text.length > (own ? 58 : 72) ? [`Full rule: “${text}”`] : []),
      ],
      small: d?.trials === 2 ? "(quick check, 2 runs)" : "(5 fresh runs)",
      links: [...run(d?.runIds[0]), ...(failedRun?.runIds?.[0] ? [{ label: "The request it learned from", href: `/runs/${failedRun.runIds[0]}` }] : [])],
      open: false,
    };
  }

  // Activated: accepted (the agent's own rule) or went live (planted / injected).
  const gatePassed = steps.find((x) => x.type === "gate_passed");
  const tested = gatePassed?.evidence ?? [];
  const injected = label === "injected";
  // The demo plan says which task set covers each planted rule, e.g. "(2) H1: only the monitoring set
  // covers it (refund_timeout_07), …": that task is what the tests don't include.
  const seedId = proposed.msg.match(/\b(H\d+)\b/)?.[1];
  const note = seedId ? plan.find((p) => p.includes(`${seedId}:`)) : undefined;
  const coveredTask = note?.match(/only the monitoring set covers it \(([^)]+)\)/)?.[1];
  return {
    ...base,
    kind: own ? "accepted" : "live",
    step: "watch",
    line1: own ? `The agent learned: ${q(text, 60)}` : q(text, 72),
    line2: [injected ? "Added directly, skipping the tests" : "Passed the tests and went live"],
    expand: [
      ...(memoryNote ? [memoryNote] : []),
      ...(tested.length ? [`Passed all ${tested.filter((t) => t.kind === "gate").length} test tasks.`] : []),
      ...(!own && coveredTask ? [`Why it got past: the tests don't include ${taskTitle(coveredTask)}.`] : []),
      ...(text.length > (own ? 60 : 72) ? [`Full rule: “${text}”`] : []),
    ],
    small: tested.length ? "(quick check, 2 runs each)" : undefined,
    links: run(tested[0]?.runIds[0]),
    open: false,
  };
}

function bisectRow(started: AutopilotEvent, inv: InvestigationView | undefined): StoryRow | null {
  const href = started.investigationId ? `/investigations/${started.investigationId}` : "";
  const link: StoryLink[] = href ? [{ label: "See the full investigation", href }] : [];
  if (!inv) {
    return { key: started.key, kind: "bisect", step: "diagnose", chip: null, line1: "Bisect started looking for the rule responsible", line2: [], expand: [], links: link, open: true };
  }
  const i = inv.investigation;
  if (i.verdict !== "verified" || !i.suspect) {
    if (i.verdict === "running") {
      return { key: started.key, kind: "bisect", step: "diagnose", chip: null, line1: "Bisect is looking for the rule responsible…", line2: [], expand: [], links: link, open: true };
    }
    return null; // an unresolved investigation is shown by its "not enough evidence" row
  }
  const last = (c: string) => [...i.verification].reverse().find((p) => p.config === c);
  const withIt = last("current");
  const without = last("current_minus_suspect");
  const harm = HARM[i.targetAssertion] ?? "failures";
  // Exact re-check wording: tasks that passed before the repair vs tasks the repair also fixed.
  const others = i.recheck.filter((r) => r.taskId !== i.failureTaskId);
  const passedBefore = others.filter((r) => r.before?.label === "GOOD");
  const kept = passedBefore.filter((r) => r.after?.label === "GOOD").length;
  const fixed = others.filter((r) => r.before?.label !== "GOOD" && r.after?.label === "GOOD").length;
  const probed = new Set(i.probes.map((p) => p.versionId)).size;
  const seconds = Math.round(inv.elapsedMs / 1000);
  const accepted = i.acceptance === "accepted";
  return {
    key: started.key,
    kind: "bisect",
    step: "diagnose",
    chip: null,
    line1: "Bisect found the rule responsible",
    line2: [
      `With it: ${withIt?.counts.targetFail ?? "?"} of ${withIt?.trials ?? 5} ${harm}. Without it: ${without?.counts.targetFail ?? "?"} of ${without?.trials ?? 5}.`,
      `${
        accepted
          ? `Removed only that rule. ${kept === passedBefore.length ? `All ${passedBefore.length}` : `${kept} of ${passedBefore.length}`} tasks that passed before still pass${fixed ? `, and ${fixed} that failed now pass` : ""}.`
          : "Removing it needs a person to decide."
      } ${shortDuration(seconds)}, ${inv.cost.runs} runs.`,
    ],
    expand: [`Searched ${i.line.length} version${i.line.length === 1 ? "" : "s"}, tested ${probed}. The rule: ${q(i.suspect.text, 45)}`],
    small: "(5 fresh runs each)",
    links: link,
    open: true,
    numbers: { seconds, runs: inv.cost.runs },
  };
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// ---------- the demo stage: one recorded session, one step at a time (the home page) ----------

export type StagePart = "autopilot" | "bisect" | "memory";
export const PARTS: { id: StagePart; label: string }[] = [
  { id: "autopilot", label: "Autopilot" },
  { id: "bisect", label: "Bisect" },
  { id: "memory", label: "Immune memory" },
];
export type CardState = "live" | "dim" | "new" | "rejected" | "suspect" | "removed" | "shield" | "incoming" | "blocked" | "passed";
export interface StageCard {
  key: string; // stable across steps, so a card's change of state animates
  text: string;
  tag?: string; // e.g. "seed" or the lesson id
  origin?: Origin;
  state: CardState;
  note?: string;
}
export interface StageDots {
  label: string;
  fail: number;
  total: number;
  note?: string;
}
export interface StageStep {
  key: string;
  part: StagePart;
  headline: string;
  sub?: string;
  cards: StageCard[];
  tone?: "normal" | "alarm";
  compare?: { old: StageCard; new: StageCard; between: string }; // the remembered rule beside a new wording
  dots?: StageDots[];
  metric?: string;
  links: StoryLink[];
  live?: { shield: StageCard }; // the last step: a rule proposed on the page, checked live
  evidence: EvidenceSection[]; // the technical detail behind the step, shown in a side panel
}
export interface EvidenceRow {
  label: string;
  value: string;
  href?: string;
}
export interface EvidenceSection {
  title: string;
  rows: EvidenceRow[];
}
export interface Stage {
  sessionId: string;
  recordedAt: string;
  steps: StageStep[];
  baseVersionId: string;
  tried: string[]; // rule texts already in this session (the live step offers other wordings)
}
// A saved run as GET /api/runs/[id] returns it (only what the stage reads).
export interface StageRun {
  toolCalls?: { tool?: string; args?: Record<string, unknown>; result?: unknown }[];
  finalStateSummary?: Record<string, unknown>;
}

// The concrete harm in one failing run, e.g. "$80 back on a $40 order" (refund checks only).
export function harmSentence(r?: StageRun | null): string | undefined {
  const st = r?.finalStateSummary;
  if (!st) return undefined;
  const paid = Number(st.amount_paid);
  const total = Number(st.refunded_total);
  const count = Number(st.refund_count);
  if (!(count >= 2 && paid > 0 && total > paid)) return undefined;
  const refunds = (r?.toolCalls ?? []).filter((c) => c.tool === "issue_refund");
  return refunds[0]?.result === "timeout"
    ? `The first $${paid} refund timed out but had gone through, so the agent refunded again: $${total} back on a $${paid} order.`
    : `The agent refunded ${count} times: $${total} back on a $${paid} order.`;
}

const runHref = (id?: string) => (id ? `/runs/${id}` : undefined);
const show = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v)?.slice(0, 80) ?? "");
const fmtCall = (c: NonNullable<StageRun["toolCalls"]>[number]) =>
  `${c.tool ?? "?"}(${Object.entries(c.args ?? {})
    .map(([k, v]) => `${k} ${show(v)}`)
    .join(", ")}) → ${show(c.result)}`;
const CONFIG_WORDS: Record<string, string> = {
  parent: "before the rule",
  introducing: "rule added",
  current: "today, with it",
  current_minus_suspect: "today, without it",
};

function rejectNote(gate: AutopilotEvent): string {
  const d = deciding(gate.evidence);
  if (!d) return "failed the tests";
  if (d.kind === "trigger") return "didn't fix its own request";
  return `broke ${brokeTitle(d.taskId)} (${d.counts.targetFail} of ${d.trials})`;
}

export function toStage(view: AutopilotView, extras: { threshold?: number | null; alarmRun?: StageRun | null } = {}): Stage {
  const s = view.session;
  const events = [...s.events].sort((a, b) => a.seq - b.seq);
  const recs = new Map((view.recognitions ?? []).map((r) => [r.recognitionId, r]));
  const invs = new Map((view.investigations ?? []).map((i) => [i.investigation.investigationId, i]));
  const rules = view.houseRules ?? {};
  const plan = events
    .filter((e) => e.type === "session_started" && e.key === "plan")
    .flatMap((e) => e.msg.split(" · ").map((x) => x.trim()).filter(Boolean));
  const start = events.find((e) => e.type === "session_started" && e.key !== "plan");

  // Each proposal with the event that decided it (gate, activation or memory).
  type P = { proposed: AutopilotEvent; decided?: AutopilotEvent; lessonId?: string };
  const proposals: P[] = [];
  for (const e of events) {
    if (e.type === "proposed") proposals.push({ proposed: e });
    const p = proposals[proposals.length - 1];
    if (!p || p.decided) continue;
    if (e.lessonId && (e.type === "gate_passed" || e.type === "gate_rejected")) p.lessonId = e.lessonId;
    if (e.type === "gate_rejected" || e.type === "activated" || e.type === "immune_blocked") p.decided = e;
  }
  const live = proposals.find((p) => p.decided?.type === "activated");
  const rejected = proposals.filter((p) => p.decided?.type === "gate_rejected" && (!live || p.proposed.seq < live.proposed.seq));
  const reg = live ? events.find((e) => e.type === "regression_confirmed" && e.seq > live.decided!.seq) : undefined;
  const invStart = reg ? events.find((e) => e.type === "investigation_started" && e.seq > reg.seq) : undefined;
  const inv = invStart?.investigationId ? invs.get(invStart.investigationId) : undefined;
  const antibody = invStart ? events.find((e) => e.type === "antibody_created" && e.seq > invStart.seq) : undefined;
  const blocked = proposals.find((p) => p.decided?.type === "immune_blocked" && (!antibody || p.proposed.seq > antibody.seq));

  const seeds: StageCard[] = (view.startLessons ?? []).map((l, n) => ({ key: `seed-${n}`, text: l.text, tag: "seed", origin: l.origin, state: "live" }));
  const as = (cards: StageCard[], state: CardState) => cards.map((c) => ({ ...c, state }));
  const card = (p: P, state: CardState, note?: string): StageCard => ({
    key: p.proposed.key,
    text: p.proposed.text ?? "",
    tag: p.lessonId,
    origin: p.proposed.label,
    state,
    note,
  });
  const i = inv?.investigation;
  const target = i?.targetAssertion ?? "";
  const harm = HARM[target] ?? "failures";
  // The rule Bisect convicted: the live card itself when it is the suspect (the usual case).
  const suspect: StageCard | null = !live
    ? null
    : i?.suspect && i.suspect.lessonId !== live.lessonId
      ? { key: `suspect-${i.suspect.lessonId}`, text: i.suspect.text, tag: i.suspect.lessonId, origin: i.suspect.origin, state: "suspect" }
      : card(live, "suspect");
  const rest = live && suspect && suspect.key !== live.proposed.key ? [...seeds, card(live, "live")] : seeds;
  const steps: StageStep[] = [];

  const ev = start?.evidence ?? [];
  const ok = ev.filter((x) => x.status === "ok").length;
  steps.push({
    key: "start",
    part: "autopilot",
    headline: `The agent starts with ${seeds.length} hand-written rule${seeds.length === 1 ? "" : "s"}.`,
    sub: "It answers support requests and proposes new rules as it goes. A new rule goes live only if it passes the tests.",
    cards: seeds,
    metric: ev.length ? `${ok === ev.length ? "All" : `${ok} of`} ${ev.length} test tasks pass` : undefined,
    links: [],
    evidence: [
      { title: "Rules it started with", rows: (view.startLessons ?? []).map((l) => ({ label: l.seedId ?? "seed", value: l.text })) },
      { title: "Tests every new rule must pass", rows: s.sets.gate.map((t) => ({ label: t, value: taskTitle(t) })) },
      { title: "Monitoring after a rule goes live", rows: s.sets.monitoring.map((t) => ({ label: t, value: taskTitle(t) })) },
    ],
  });

  if (rejected.length) {
    steps.push({
      key: "rejected",
      part: "autopilot",
      headline: `The tests reject ${rejected.length === 1 ? "a new rule" : `${rejected.length} new rules`}.`,
      sub: "Each new rule is tried on the test tasks with fresh runs before it can go live.",
      cards: [...as(seeds, "dim"), ...rejected.map((p) => card(p, "rejected", rejectNote(p.decided!)))],
      links: run(deciding(rejected[0].decided!.evidence)?.runIds[0]),
      evidence: rejected.map((p) => {
        const d = deciding(p.decided!.evidence);
        return {
          title: `${p.proposed.label ?? ""} rule ${p.lessonId ?? ""}`.trim(),
          rows: [
            { label: "rule", value: p.proposed.text ?? "" },
            ...(d
              ? [
                  { label: d.kind === "trigger" ? "own request" : "broke", value: `${taskTitle(d.taskId)} (${d.taskId})` },
                  {
                    label: "fresh runs",
                    value: d.kind === "trigger" ? `${d.trials - d.counts.pass} of ${d.trials} still failed` : `${d.counts.targetFail} of ${d.trials} failed the check`,
                    href: runHref(d.runIds[0]),
                  },
                ]
              : []),
          ],
        };
      }),
    });
  }

  if (live) {
    const injected = live.proposed.label === "injected";
    const seedId = live.proposed.msg.match(/\b(H\d+)\b/)?.[1];
    const note = seedId ? plan.find((x) => x.includes(`${seedId}:`)) : undefined;
    const covered = note?.match(/only the monitoring set covers it \(([^)]+)\)/)?.[1];
    steps.push({
      key: "live",
      part: "autopilot",
      headline: injected ? "This rule skips the tests and goes live." : "This rule passes the tests and goes live.",
      sub: covered ? `Why it got past: the tests don't include ${taskTitle(covered)}.` : undefined,
      cards: [...seeds, card(live, "new", injected ? "added directly" : "passed the tests")],
      links: [],
      evidence: [
        {
          title: `${live.proposed.label ?? ""} rule ${live.lessonId ?? ""}`.trim(),
          rows: [
            { label: "rule", value: live.proposed.text ?? "" },
            ...(injected ? [{ label: "tests", value: "skipped (injected directly)" }] : gateRows(events, live)),
            ...(note ? [{ label: "demo plan", value: note }] : []),
            { label: "went live as", value: live.decided!.versionId ?? "" },
          ],
        },
      ],
    });
  }

  if (live && reg) {
    const bad = (reg.evidence ?? []).find((x) => x.label === "BAD");
    const wrong = rules[target]?.wrong;
    steps.push({
      key: "alarm",
      part: "autopilot",
      headline: wrong ? `Monitoring catches it: the agent ${wrong}.` : `Monitoring catches a failure on ${taskTitle(reg.taskId ?? "")}.`,
      sub: harmSentence(extras.alarmRun) ?? `It happens on ${taskTitle(reg.taskId ?? bad?.taskId ?? "")}, which passed before.`,
      cards: [...seeds, card(live, "live")],
      tone: "alarm",
      dots: bad ? [{ label: "Fresh runs", fail: bad.counts.targetFail, total: bad.trials, note: harm }] : undefined,
      links: run(bad?.runIds[0]),
      evidence: alarmEvidence(reg, bad, rules[target], target, extras.alarmRun),
    });
  }

  if (inv && i && suspect && i.verdict === "verified") {
    const last = (c: string) => [...i.verification].reverse().find((p) => p.config === c);
    const withIt = last("current");
    const without = last("current_minus_suspect");
    const invLink = [{ label: "See the full investigation", href: `/investigations/${i.investigationId}` }];
    steps.push({
      key: "found",
      part: "bisect",
      headline: "Bisect finds the rule that did it.",
      sub: `It searched ${i.line.length} version${i.line.length === 1 ? "" : "s"} and re-ran the failing request with and without the suspect rule.`,
      cards: [...as(rest, "dim"), { ...suspect, state: "suspect" }],
      dots:
        withIt && without
          ? [
              { label: "With the rule", fail: withIt.counts.targetFail, total: withIt.trials, note: harm },
              { label: "Without it", fail: without.counts.targetFail, total: without.trials, note: without.counts.targetFail ? harm : `no ${harm}` },
            ]
          : undefined,
      links: invLink,
      evidence: [
        {
          title: "Search",
          rows: [
            { label: "versions", value: i.line.map((l) => l.versionId).join(" → ") },
            { label: "suspect", value: `${i.suspect?.lessonId ?? ""}: ${i.suspect?.text ?? ""}` },
          ],
        },
        {
          title: `Verification (${LIMITS.confirmTrials} fresh runs each)`,
          rows: ["parent", "introducing", "current", "current_minus_suspect"].flatMap((c) => {
            const pr = last(c);
            return pr
              ? [{ label: CONFIG_WORDS[c], value: `${pr.versionId}: ${pr.label ?? "?"}, ${pr.counts.pass} of ${pr.trials} passed`, href: runHref(pr.runIds[0]) }]
              : [];
          }),
        },
      ],
    });
    const others = i.recheck.filter((r) => r.taskId !== i.failureTaskId);
    const passedBefore = others.filter((r) => r.before?.label === "GOOD");
    const kept = passedBefore.filter((r) => r.after?.label === "GOOD").length;
    const fixed = others.filter((r) => r.before?.label !== "GOOD" && r.after?.label === "GOOD").length;
    const accepted = i.acceptance === "accepted";
    steps.push({
      key: "removed",
      part: "bisect",
      headline: accepted ? "It removes only that rule." : "Removing it needs a person to decide.",
      sub: accepted
        ? `Re-checked ${others.length} other tasks: ${kept === passedBefore.length ? "all" : `${kept} of`} ${passedBefore.length} that passed before still pass${fixed ? `, and ${fixed} that failed now pass` : ""}.`
        : undefined,
      cards: [...as(rest, "live"), { ...suspect, state: accepted ? "removed" : "suspect", note: accepted ? "removed" : undefined }],
      metric: `${shortDuration(Math.round(inv.elapsedMs / 1000))} · ${inv.cost.runs} fresh runs`,
      links: invLink,
      evidence: [
        {
          title: "Repair",
          rows: [
            { label: "new version", value: `${i.repairVersionId ?? "?"} = ${withIt?.versionId ?? "?"} without ${i.suspect?.lessonId ?? "the rule"}` },
            { label: "cost", value: `${inv.cost.runs} runs, ${shortDuration(Math.round(inv.elapsedMs / 1000))}` },
          ],
        },
        {
          title: `Re-check: ${others.length} other tasks, before → after`,
          rows: others.map((r) => ({ label: r.taskId, value: `${r.before?.label ?? "?"} → ${r.after?.label ?? "?"}`, href: runHref(r.after?.runIds?.[0]) })),
        },
      ],
    });
  }

  const shield: StageCard | null = suspect ? { ...suspect, state: "shield", note: "remembered" } : null;
  if (antibody && shield) {
    steps.push({
      key: "remembered",
      part: "memory",
      headline: "The rule is remembered.",
      sub: "Its failing request is saved with it. A new rule that looks similar gets that request replayed before it can go live.",
      cards: [...as(rest, "live"), shield],
      links: [{ label: "See the memory", href: "/immune" }],
      evidence: [
        {
          title: "What is stored",
          rows: [
            { label: "rule", value: shield.text },
            ...(i ? [{ label: "its case", value: `${taskTitle(i.failureTaskId)} (${i.failureTaskId}), check ${target}` }] : []),
            { label: "matching", value: "the rule's text is embedded (Voyage voyage-3.5-lite, 1024 dims) and found with MongoDB Atlas Vector Search" },
            { label: "blocking", value: `a match at or above the threshold replays the case with ${LIMITS.confirmTrials} fresh runs; only a failed replay blocks` },
          ],
        },
      ],
    });
  }

  if (blocked && shield) {
    const r = blocked.decided?.recognitionId ? recs.get(blocked.decided.recognitionId) : undefined;
    const rep = r?.replays.find((x) => x.antibodyId === r.blockedBy) ?? r?.replays[0];
    const matched = r?.matches.find((m) => m.antibodyId === rep?.antibodyId);
    const seconds = secs(blocked.decided?.ms ?? r?.ms ?? 0);
    const runs = blocked.decided?.runs ?? r?.runs ?? 0;
    const thr = r?.threshold ?? extras.threshold ?? null;
    const pct = rep ? Math.round(rep.score * 100) : null;
    steps.push({
      key: "blocked",
      part: "memory",
      headline: `The same idea in new words is blocked in ${seconds} s.`,
      sub: rep
        ? `It is ${pct}% similar to the remembered rule${thr ? ` (threshold ${Math.round(thr * 100)}%)` : ""}, so the old request was replayed with it: ${rep.probe.counts.targetFail} of ${rep.probe.trials} runs failed.`
        : undefined,
      cards: [],
      compare: { old: { ...shield, text: matched?.lessonText ?? shield.text }, new: card(blocked, "blocked", "blocked"), between: pct !== null ? `${pct}% similar` : "similar" },
      dots: rep ? [{ label: "Replay", fail: rep.probe.counts.targetFail, total: rep.probe.trials, note: harm }] : undefined,
      metric: `${seconds} s · ${runs} runs${inv ? ` (first catch: ${shortDuration(Math.round(inv.elapsedMs / 1000))} · ${inv.cost.runs} runs)` : ""}`,
      links: run(rep?.probe.runIds[0]),
      evidence: [
        {
          title: "Similarity search",
          rows: [
            { label: "new wording", value: blocked.proposed.text ?? "" },
            ...(r?.matches ?? []).map((m) => ({ label: m.antibodyId, value: `score ${m.score.toFixed(3)} (threshold ${thr ?? "?"}): ${m.lessonText}` })),
          ],
        },
        ...(rep
          ? [
              {
                title: "Replay",
                rows: [
                  { label: "case", value: `${taskTitle(rep.probe.taskId)} (${rep.probe.taskId})` },
                  { label: "fresh runs", value: `${rep.probe.counts.targetFail} of ${rep.probe.trials} failed the check → blocked`, href: runHref(rep.probe.runIds[0]) },
                  { label: "time", value: `${seconds} s, ${runs} runs` },
                ],
              },
            ]
          : []),
      ],
    });
  }

  if (antibody && shield) {
    steps.push({
      key: "try",
      part: "memory",
      headline: "Try a rule: memory checks it live.",
      sub: `If it looks like the remembered rule, the old request is replayed with it (${LIMITS.confirmTrials} fresh runs).`,
      cards: [],
      links: [],
      live: { shield },
      evidence: [],
    });
  }

  return {
    sessionId: s.sessionId,
    recordedAt: String(s.createdAt),
    steps,
    baseVersionId: s.activeVersionId,
    tried: [...new Set(events.flatMap((e) => (e.text ? [e.text] : [])))],
  };
}

// The gate's result for a rule that went live: how many test tasks it passed, with a trace.
function gateRows(events: AutopilotEvent[], live: { proposed: AutopilotEvent; decided?: AutopilotEvent }): EvidenceRow[] {
  const passed = events.find((e) => e.type === "gate_passed" && e.seq > live.proposed.seq && (!live.decided || e.seq <= live.decided.seq));
  const tasks = (passed?.evidence ?? []).filter((x) => x.kind === "gate");
  return tasks.length ? [{ label: "tests", value: `passed all ${tasks.length} test tasks (quick check, 2 runs each)`, href: runHref(tasks[0].runIds[0]) }] : [];
}

function alarmEvidence(
  reg: AutopilotEvent,
  bad: EvidenceItem | undefined,
  rule: { text: string; wrong: string } | undefined,
  target: string,
  r: StageRun | null | undefined,
): EvidenceSection[] {
  const task = bad?.taskId ?? reg.taskId ?? "";
  const st = r?.finalStateSummary ?? {};
  const keys = ["refund_count", "refunded_total", "amount_paid"].filter((k) => k in st);
  return [
    {
      title: "The failing run",
      rows: [
        { label: "request", value: `${taskTitle(task)} (${task})` },
        ...(r?.toolCalls ?? []).map((c, n) => ({ label: `call ${n + 1}`, value: fmtCall(c) })),
        ...(keys.length ? [{ label: "final state", value: keys.map((k) => `${k} ${show(st[k])}`).join(", ") }] : []),
        { label: "check", value: rule ? `${rule.text} (${target})` : target },
      ],
    },
    ...(bad ? [{ title: "Monitoring", rows: [{ label: "fresh runs", value: `${bad.counts.targetFail} of ${bad.trials} failed the check`, href: runHref(bad.runIds[0]) }] }] : []),
  ];
}
