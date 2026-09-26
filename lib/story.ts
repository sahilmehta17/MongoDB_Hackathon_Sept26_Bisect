// Turns one autopilot session into the story shown on /autopilot/[id]: one row per rule and per
// notable moment, in the order they happened (UI spec §5). Pure: reads the view, never the database.
import type { AutopilotEvent, AutopilotView, EvidenceItem, InvestigationView, Recognition } from "@/lib/types";

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
      line1: label === "visitor" ? `A visitor tried: ${q(text)}` : `The agent tried again in new words: ${q(text)}`,
      line2: rep
        ? [`Recognized (${Math.round(rep.score * 100)}% similar) → replayed the old case: ${rep.probe.counts.targetFail} of ${rep.probe.trials} → blocked in ${seconds} s`]
        : [`Blocked in ${seconds} s`],
      expand: [
        ...(matched ? [`It matched a rule caught earlier: ${q(matched.lessonText, 60)}`] : []),
        ...(text.length > 90 ? [`Full rule: “${text}”`] : []),
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
      line1: own ? `The agent's own rule: ${q(text)}` : q(text),
      line2: [
        trigger
          ? `Blocked by tests: it didn't fix the request it was learned from (${n - (d?.counts.pass ?? 0)} of ${n} fresh runs still failed)`
          : `Blocked by tests: it broke ${d ? brokeTitle(d.taskId) : "a task that passed before"} (${x} of ${n} fresh runs)`,
      ],
      expand: [
        ...(memoryNote ? [memoryNote] : []),
        ...(d && !trigger ? [`${cap(taskTitle(d.taskId))} passed before this rule; with it, ${x} of ${n} fresh runs failed.`] : []),
        ...(text.length > 90 ? [`Full rule: “${text}”`] : []),
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
    line1: own ? `The agent learned: ${q(text)}` : q(text),
    line2: [injected ? "Added directly, skipping the tests" : "Passed the tests and went live"],
    expand: [
      ...(memoryNote ? [memoryNote] : []),
      ...(tested.length ? [`Passed all ${tested.filter((t) => t.kind === "gate").length} test tasks.`] : []),
      ...(!own && coveredTask ? [`Why it got past: the tests don't include ${taskTitle(coveredTask)}.`] : []),
      ...(text.length > 90 ? [`Full rule: “${text}”`] : []),
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
  const others = i.recheck.filter((r) => r.taskId !== i.failureTaskId);
  const stillGood = others.filter((r) => r.after.label === "GOOD").length;
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
      accepted
        ? `Removed only that rule. ${stillGood === others.length ? `All ${others.length}` : `${stillGood} of ${others.length}`} other tasks still pass.`
        : `Removing it needs a person to decide.`,
      `${shortDuration(seconds)}, ${inv.cost.runs} runs.`,
    ],
    expand: [`Searched ${i.line.length} version${i.line.length === 1 ? "" : "s"}, tested ${probed}. The rule: ${q(i.suspect.text, 60)}`],
    small: "(5 fresh runs each)",
    links: link,
    open: true,
    numbers: { seconds, runs: inv.cost.runs },
  };
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
