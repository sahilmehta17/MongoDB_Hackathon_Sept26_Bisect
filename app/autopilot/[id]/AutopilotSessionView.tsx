"use client";

// The autopilot pages.
// - AutopilotSessionView (/autopilot/[id]): loads GET /api/autopilot/[id], polls every 3 s while the
//   session is running or waiting for a decision, and explains in plain language what autopilot did:
//   every event with its evidence (sample sizes and run links), the Approve / Reject decision when a
//   repair needs a person, and how the demo branch was chosen.
// - AutopilotHome (/autopilot): lists sessions and starts the demo.
// Only numbers that are in the data are shown, always with their sample size.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type {
  AutopilotEvent,
  AutopilotEventType,
  AutopilotSession,
  AutopilotView,
  Cost,
  Counts,
  EvidenceItem,
  Label,
  Origin,
  StreamItem,
} from "@/lib/types";
import { LIMITS } from "@/lib/types";
import styles from "../autopilot.module.css";

const POLL_MS = 3000;

type Tone = "good" | "bad" | "warn" | "info" | "neutral";
type Status = AutopilotSession["status"];

// Fixed settings from lib/autopilot/steps.ts, passed in by the server page.
export interface SessionLimits {
  maxRuns: number;
  maxModelCalls: number;
  monitorEvery: number;
}

// ---------- helpers ----------

async function errorText(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body.error === "string") return `${body.error} (HTTP ${res.status})`;
  } catch {
    // not JSON; fall through
  }
  return `HTTP ${res.status} ${res.statusText}`.trim();
}

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");
const NO_COST: Cost = { runs: 0, modelCalls: 0, tokens: 0, errors: 0 };
const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;
const fmt = (n: number) => n.toLocaleString("en-US");

function clock(ms: number): string {
  if (!Number.isFinite(ms)) return "–";
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

function dateTime(x: Date | string | null | undefined): string {
  if (!x) return "–";
  const d = new Date(x);
  if (Number.isNaN(d.getTime())) return String(x);
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

const TONE_CLASS: Record<Tone, string> = {
  good: styles.toneGood,
  bad: styles.toneBad,
  warn: styles.toneWarn,
  info: styles.toneInfo,
  neutral: styles.toneNeutral,
};

const TYPE_CLASS: Record<Tone, string> = {
  good: styles.typeGood,
  bad: styles.typeBad,
  warn: styles.typeWarn,
  info: styles.typeInfo,
  neutral: styles.typeNeutral,
};

const CELL_CLASS: Record<Tone, string | undefined> = {
  good: styles.cellGood,
  bad: styles.cellBad,
  warn: styles.cellWarn,
  info: undefined,
  neutral: undefined,
};

// ---------- wording ----------

const STATUS: Record<Status, { text: string; tone: Tone }> = {
  running: { text: "Running", tone: "info" },
  awaiting_decision: { text: "Waiting for your decision", tone: "warn" },
  done: { text: "Done", tone: "good" },
  stopped: { text: "Stopped (budget)", tone: "warn" },
  error: { text: "Error", tone: "bad" },
};

const statusInfo = (s: string) => STATUS[s as Status] ?? { text: s, tone: "neutral" as Tone };
const isLive = (s: string) => s === "running" || s === "awaiting_decision";

const ORIGIN_TEXT: Record<Origin, string> = {
  natural: "learned by the agent itself",
  planted: "planted test case",
  injected: "injected (bypassed the gate)",
  visitor: "submitted by a visitor",
  seeded: "hand-written useful lesson",
};

const ORIGIN_CLASS: Record<Origin, string> = {
  natural: styles.originNatural,
  planted: styles.originPlanted,
  injected: styles.originInjected,
  visitor: styles.originVisitor,
  seeded: styles.originSeeded,
};

function OriginChip({ origin }: { origin: Origin }) {
  return <span className={cx(styles.origin, ORIGIN_CLASS[origin])}>{ORIGIN_TEXT[origin] ?? origin}</span>;
}

type StageId = "propose" | "immune" | "gate" | "activate" | "monitor" | "bisect" | "repair";

interface EventInfo {
  text: string;
  tone: Tone;
  strong?: boolean; // a key moment: filled badge
  stage: StageId | null;
}

const EVENT: Record<AutopilotEventType, EventInfo> = {
  session_started: { text: "Session started", tone: "neutral", stage: null },
  training_run: { text: "Training run", tone: "neutral", stage: "propose" },
  no_proposal: { text: "No lesson proposed", tone: "neutral", stage: "propose" },
  proposed: { text: "Lesson proposed", tone: "neutral", stage: "propose" },
  immune_blocked: { text: "Immune check: blocked", tone: "bad", strong: true, stage: "immune" },
  immune_passed: { text: "Immune check: resembled a known bad habit, passed its replay", tone: "good", stage: "immune" },
  immune_no_match: { text: "Immune check: no known bad habit matched", tone: "neutral", stage: "immune" },
  immune_skipped: { text: "Immune check: skipped (not calibrated)", tone: "neutral", stage: "immune" },
  gate_passed: { text: "Gate passed", tone: "good", stage: "gate" },
  gate_rejected: { text: "Gate rejected", tone: "bad", strong: true, stage: "gate" },
  activated: { text: "Activated", tone: "good", strong: true, stage: "activate" },
  monitor_ok: { text: "Monitoring OK", tone: "good", stage: "monitor" },
  false_alarm: { text: "False alarm (confirmed OK)", tone: "good", stage: "monitor" },
  regression_confirmed: { text: "Regression confirmed", tone: "bad", strong: true, stage: "monitor" },
  investigation_started: { text: "Bisect started", tone: "neutral", stage: "bisect" },
  antibody_created: { text: "Antibody created", tone: "info", stage: "bisect" },
  repair_activated: { text: "Repair activated", tone: "good", strong: true, stage: "repair" },
  awaiting_decision: { text: "Waiting for a decision", tone: "warn", strong: true, stage: "repair" },
  decision: { text: "Decision", tone: "neutral", stage: "repair" },
  budget_stop: { text: "Run budget used up", tone: "warn", strong: true, stage: null },
  insufficient_evidence: { text: "Not enough evidence", tone: "warn", stage: "monitor" },
  session_done: { text: "Session done", tone: "neutral", stage: null },
};

function eventInfo(e: AutopilotEvent, status: string): EventInfo {
  const base: EventInfo = EVENT[e.type] ?? { text: String(e.type).replace(/_/g, " "), tone: "neutral", stage: null };
  switch (e.type) {
    case "immune_passed":
      // Logged without a recognition when the immune threshold isn't calibrated yet (the check was skipped).
      return e.recognitionId ? base : { ...base, text: "Immune check: skipped", tone: "neutral" };
    case "insufficient_evidence":
      return e.investigationId ? { ...base, stage: "bisect" } : base;
    case "decision":
      if (/\bapproved\b/.test(e.msg)) return { ...base, text: "Approved by a person" };
      if (/\brejected\b/.test(e.msg)) return { ...base, text: "Rejected by a person" };
      return base;
    case "session_done":
      if (status === "error") return { ...base, text: "Stopped by an error", tone: "bad", strong: true };
      if (status === "stopped") return { ...base, text: "Stopped (budget)", tone: "warn", strong: true };
      return base;
    default:
      return base;
  }
}

// A training run's result, from its message ("<task> passed on vN" / "<task> failed on vN: ...").
function trainingResult(e: AutopilotEvent): "passed" | "failed" | null {
  if (e.type !== "training_run" || !e.taskId) return null;
  if (e.msg.startsWith(`${e.taskId} passed`)) return "passed";
  if (e.msg.startsWith(`${e.taskId} failed`)) return "failed";
  return null;
}

function describeItem(item: StreamItem | undefined): { title: ReactNode; plain: string; short: string; note?: string; demo: boolean } {
  if (!item) return { title: "unknown item", plain: "unknown item", short: "?", demo: false };
  switch (item.kind) {
    case "training":
      return {
        title: (
          <>
            training request <code>{item.taskId}</code>
          </>
        ),
        plain: `training request ${item.taskId}`,
        short: item.taskId,
        demo: false,
      };
    case "planted":
      return { title: item.note, plain: item.note, short: `planted ${item.seedId}`, note: "submitted through the gate on purpose", demo: true };
    case "injected":
      return { title: item.note, plain: item.note, short: `injected ${item.seedId}`, note: "added without the gate, labelled so", demo: true };
    case "reworded":
      return {
        title: item.note,
        plain: item.note,
        short: `reworded ${item.seedId}`,
        note: "a rewording of an earlier harmful rule, submitted like any other lesson",
        demo: true,
      };
    case "monitor":
      return { title: item.note, plain: item.note, short: "monitor", demo: false };
    default:
      return { title: "unknown item", plain: "unknown item", short: "?", demo: false };
  }
}

// ---------- small pieces ----------

function RunLinks({ runIds, label = "runs" }: { runIds: string[]; label?: string }) {
  if (!runIds?.length) return null;
  return (
    <span className="runs">
      <span className="runs-label">{label}</span>
      {runIds.map((r, i) => (
        <Link key={r} href={`/runs/${encodeURIComponent(r)}`} prefetch={false} title={`Run ${r}`} aria-label={`Run ${r}`}>
          {i + 1}
        </Link>
      ))}
    </span>
  );
}

function Shield({ kind }: { kind: "blocked" | "passed" | "skipped" }) {
  return (
    <svg className={styles.shield} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        d="M12 2.5 4.5 5.4v5.9c0 4.7 3.2 8.8 7.5 10.2 4.3-1.4 7.5-5.5 7.5-10.2V5.4L12 2.5Z"
        fill="currentColor"
        fillOpacity="0.2"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      {kind === "blocked" ? (
        <path d="M9.3 9.3l5.4 5.4M14.7 9.3l-5.4 5.4" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
      ) : kind === "passed" ? (
        <path d="M8.6 12.4l2.4 2.4 4.6-4.9" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
      ) : (
        <path d="M9 12h6" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
      )}
    </svg>
  );
}

// ---------- loading ----------

type LoadState =
  | { kind: "loading" }
  | { kind: "notfound" }
  | { kind: "error"; message: string }
  | { kind: "ready"; view: AutopilotView; fetchedAt: number; stale: string | null };

function useAutopilot(id: string) {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [nonce, setNonce] = useState(0);
  const live = useRef(false); // whether the last data received was a running session

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const res = await fetch(`/api/autopilot/${encodeURIComponent(id)}`, { cache: "no-store" });
        if (cancelled) return;
        if (res.status === 404) {
          setState({ kind: "notfound" });
          return;
        }
        if (!res.ok) throw new Error(await errorText(res));
        const view = (await res.json()) as AutopilotView;
        if (cancelled) return;
        live.current = isLive(view.session.status);
        setState({ kind: "ready", view, fetchedAt: Date.now(), stale: null });
        if (live.current) timer = setTimeout(load, POLL_MS);
      } catch (e) {
        if (cancelled) return;
        const message = e instanceof Error ? e.message : String(e);
        // Keep showing the last good data, and keep trying while the session was running.
        setState((prev) => (prev.kind === "ready" ? { ...prev, stale: message } : { kind: "error", message }));
        if (live.current) timer = setTimeout(load, POLL_MS);
      }
    };
    void load();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [id, nonce]);

  const refresh = useCallback(() => setNonce((n) => n + 1), []); // load now, keep what's shown
  const retry = useCallback(() => {
    setState({ kind: "loading" });
    setNonce((n) => n + 1);
  }, []);
  return { state, refresh, retry };
}

// A clock that ticks once a second while `active`.
function useNow(active: boolean): number {
  const [now, setNow] = useState(0);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

// ---------- the session page ----------

export default function AutopilotSessionView({ id, limits }: { id: string; limits: SessionLimits }) {
  const { state, refresh, retry } = useAutopilot(id);
  const live = state.kind === "ready" && isLive(state.view.session.status);
  const now = useNow(live);

  if (state.kind === "loading") {
    return (
      <main className="report" aria-busy="true">
        <p className="status-msg">Loading autopilot session {id}…</p>
      </main>
    );
  }
  if (state.kind === "notfound") {
    return (
      <main className="report">
        <div className="notice notice-warn">
          <h1>No autopilot session with that id</h1>
          <p>
            Nothing is saved under <code>{id}</code>. Check the link, or <Link href="/autopilot">see all autopilot sessions</Link>.
          </p>
        </div>
      </main>
    );
  }
  if (state.kind === "error") {
    return (
      <main className="report">
        <div className="notice notice-bad" role="alert">
          <h1>Couldn&apos;t load autopilot session {id}</h1>
          <p>{state.message}</p>
          <button type="button" className="button" onClick={retry}>
            Try again
          </button>
        </div>
      </main>
    );
  }

  const { view, fetchedAt, stale } = state;
  const elapsed = view.elapsedMs + (live && now > fetchedAt ? now - fetchedAt : 0);
  return <Session view={view} limits={limits} elapsedMs={elapsed} stale={stale} onChanged={refresh} />;
}

function Session({
  view,
  limits,
  elapsedMs,
  stale,
  onChanged,
}: {
  view: AutopilotView;
  limits: SessionLimits;
  elapsedMs: number;
  stale: string | null;
  onChanged: () => void;
}) {
  const s = view.session;
  const events = [...(s.events ?? [])].sort((a, b) => a.seq - b.seq);
  const st = statusInfo(s.status);
  const doneEvent = events.find((e) => e.type === "session_done");
  const budgetEvent = events.find((e) => e.type === "budget_stop");

  return (
    <main className="report">
      {stale ? (
        <div className="notice notice-warn" role="status">
          Couldn&apos;t refresh ({stale}). Showing the last data received; retrying every {POLL_MS / 1000} s.
        </div>
      ) : null}

      <header className="report-head">
        <p className="eyebrow">
          <Link href="/">Bisect</Link> · <Link href="/autopilot">Autopilot</Link> · the learning loop, running on its own
        </p>
        <div className="title-row">
          <h1>Autopilot session {s.sessionId}</h1>
          <span className={`badge badge-${st.tone}`}>
            {s.status === "running" ? <span className="pulse" aria-hidden="true" /> : null}
            {st.text}
            {isLive(s.status) ? <span className="badge-timer">{clock(elapsedMs)}</span> : null}
          </span>
        </div>
        <p className={styles.subline}>
          History <code>{s.historyId}</code> · started on <code>{s.startVersionId}</code> at {dateTime(s.createdAt)}
          {s.finishedAt ? <> · finished {dateTime(s.finishedAt)}</> : null}
        </p>
      </header>

      {s.status === "error" ? (
        <div className="notice notice-bad" role="alert">
          <strong>Autopilot stopped on an error.</strong> {doneEvent?.msg ?? "No error message was recorded."}
        </div>
      ) : null}
      {s.status === "stopped" ? (
        <div className="notice notice-warn">
          <strong>Stopped: the session&apos;s run budget ran out.</strong> {budgetEvent?.msg ?? doneEvent?.msg ?? ""}
        </div>
      ) : null}
      {s.status === "awaiting_decision" ? (
        <DecisionPanel key={s.pendingRepair?.investigationId ?? "none"} view={view} events={events} onDecided={onChanged} />
      ) : null}

      <section aria-label="Session status">
        <p className="lead">
          Each training request runs on the active version. A failure proposes one lesson, which has to pass the immune check and the gate
          before it&apos;s activated. Every {limits.monitorEvery} activations the monitoring set is checked; a confirmed regression makes
          Bisect start itself and remove only the lesson that caused it.
        </p>
        <Facts view={view} events={events} limits={limits} elapsedMs={elapsedMs} />
      </section>

      <Pipeline events={events} status={s.status} monitorEvery={limits.monitorEvery} />
      <DemoPlan view={view} events={events} />
      <Timeline view={view} events={events} monitorEvery={limits.monitorEvery} />
    </main>
  );
}

// ---------- header facts ----------

function Fact({ label, value, note, children }: { label: string; value: ReactNode; note?: ReactNode; children?: ReactNode }) {
  return (
    <div className={styles.fact}>
      <dt>{label}</dt>
      <dd>
        <span className={styles.factValue}>{value}</span>
        {note ? <span className={styles.factNote}>{note}</span> : null}
        {children}
      </dd>
    </div>
  );
}

function Facts({ view, events, limits, elapsedMs }: { view: AutopilotView; events: AutopilotEvent[]; limits: SessionLimits; elapsedMs: number }) {
  const s = view.session;
  const stream = s.stream ?? [];
  const total = stream.length;
  const pos = Math.min(s.position, total);
  const latest = events[events.length - 1];
  const live = isLive(s.status);

  let streamValue: string;
  let streamNote: string;
  if (live && pos < total) {
    streamValue = `Item ${pos + 1} of ${total}`;
    streamNote =
      s.status === "awaiting_decision"
        ? "up next; paused until you decide"
        : latest && /^s\d+-auto-/.test(latest.key)
          ? "up next, after the automatic monitoring check"
          : describeItem(stream[pos]).plain;
  } else if (live) {
    streamValue = `${total} of ${total}`;
    streamNote = "every item processed; finishing";
  } else {
    streamValue = `${pos} of ${total}`;
    streamNote = pos >= total ? "every item processed" : "items processed before it stopped";
  }

  const cost = view.cost ?? NO_COST;
  const imm = view.immuneCost ?? NO_COST;
  const used = limits.maxRuns > 0 ? cost.runs / limits.maxRuns : 0;
  const lessons = view.activeLessonIds ?? [];

  return (
    <>
      <dl className={styles.facts}>
        <Fact label="Active version" value={<code>{s.activeVersionId}</code>} note={plural(lessons.length, "lesson")}>
          {lessons.length ? (
            <details className={styles.lessonList}>
              <summary>Show lessons</summary>
              <ul>
                {lessons.map((id) => {
                  const l = view.lessons?.[id];
                  return (
                    <li key={id}>
                      <code>{id}</code>{" "}
                      {l ? (
                        <>
                          “{l.text}” <OriginChip origin={l.origin} />
                        </>
                      ) : (
                        <span className="muted">(text not in this view)</span>
                      )}
                    </li>
                  );
                })}
              </ul>
            </details>
          ) : null}
        </Fact>
        <Fact
          label="Candidate"
          value={s.candidateVersionId ? <code>{s.candidateVersionId}</code> : "none"}
          note={
            !s.candidateVersionId
              ? "at most one at a time"
              : live
                ? "being checked by the gate"
                : "never activated: the session stopped first"
          }
        />
        <Fact label="Stream" value={streamValue} note={streamNote} />
        <Fact label="Activations" value={fmt(s.activations)} note={`monitoring every ${limits.monitorEvery}`} />
        <Fact label="Elapsed" value={clock(elapsedMs)} note={live ? "still running" : s.finishedAt ? "until it finished" : undefined} />
        <Fact label="Session runs" value={fmt(cost.runs)} note={`of a ${fmt(limits.maxRuns)}-run budget`}>
          <div className={cx(styles.meter, used >= 0.8 && styles.meterHigh)} aria-hidden="true">
            <div className={styles.meterFill} style={{ width: `${Math.min(100, used * 100)}%` }} />
          </div>
        </Fact>
        <Fact label="Immune replays" value={fmt(imm.runs)} note="runs; each check has its own budget" />
        <Fact
          label="Model calls"
          value={fmt(cost.modelCalls + imm.modelCalls)}
          note={`${fmt(cost.modelCalls)} session (budget ${fmt(limits.maxModelCalls)}) + ${fmt(imm.modelCalls)} immune`}
        />
        <Fact label="Tokens" value={fmt(cost.tokens + imm.tokens)} note={`${fmt(cost.tokens)} session + ${fmt(imm.tokens)} immune`} />
        <Fact label="Infra errors" value={fmt(cost.errors + imm.errors)} note="runs that errored; never counted as pass or fail" />
      </dl>
      <p className={styles.costNote}>
        Counted from the saved run records. Investigations that Bisect starts have their own run budget: see each investigation&apos;s page.
      </p>
    </>
  );
}

// ---------- Approve / Reject ----------

function DecisionPanel({ view, events, onDecided }: { view: AutopilotView; events: AutopilotEvent[]; onDecided: () => void }) {
  const s = view.session;
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const [sent, setSent] = useState<"approve" | "reject" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const pending = s.pendingRepair;
  if (!pending) {
    return (
      <div className="notice notice-warn" role="status">
        <strong>Waiting for a decision</strong>, but no pending repair is recorded on the session.
      </div>
    );
  }

  const inv = pending.investigationId;
  const recorded = s.decision ?? sent;
  const disabled = busy !== null || recorded !== null;
  const note = [...events].reverse().find((e) => e.type === "awaiting_decision" && e.investigationId === inv);
  const started = events.find((e) => e.type === "investigation_started" && e.investigationId === inv);
  const antibody = events.find((e) => e.type === "antibody_created" && e.investigationId === inv);
  const lessonId = antibody?.lessonId;
  const lesson = lessonId ? view.lessons?.[lessonId] : undefined;

  const decide = async (decision: "approve" | "reject") => {
    setBusy(decision);
    setError(null);
    try {
      const res = await fetch(`/api/autopilot/${encodeURIComponent(s.sessionId)}/decision`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision }),
      });
      if (!res.ok) throw new Error(await errorText(res));
      setSent(decision);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
      onDecided(); // reload now either way, to show what the server has
    }
  };

  return (
    <section className={styles.decision} aria-labelledby="decision-h">
      <h2 id="decision-h">Waiting for your decision</h2>
      <p>
        Bisect found and verified the lesson behind the regression
        {started?.taskId ? (
          <>
            {" "}
            on <code>{started.taskId}</code>
          </>
        ) : null}
        {lessonId ? (
          <>
            : lesson <code>{lessonId}</code>
            {lesson ? null : "."}
          </>
        ) : (
          "."
        )}
      </p>
      {lesson ? (
        <blockquote className={styles.rule}>
          “{lesson.text}” <OriginChip origin={lesson.origin} />
        </blockquote>
      ) : null}
      <p>
        Repair <code>{pending.repairVersionId}</code> is the active version <code>{s.activeVersionId}</code> with only that lesson removed,
        but it didn&apos;t meet the bar for automatic activation, so a person decides.
      </p>
      {note ? (
        <p>
          <strong>Bisect&apos;s note:</strong> {note.msg}
        </p>
      ) : null}
      <p>
        <Link href={`/investigations/${encodeURIComponent(inv)}`}>Read the evidence in investigation {inv} →</Link>
      </p>
      <div className={styles.decisionActions}>
        <button type="button" className={styles.approve} disabled={disabled} onClick={() => void decide("approve")}>
          {busy === "approve" ? "Sending…" : <>Approve: activate {pending.repairVersionId}</>}
        </button>
        <button type="button" className={styles.reject} disabled={disabled} onClick={() => void decide("reject")}>
          {busy === "reject" ? "Sending…" : <>Reject: keep {s.activeVersionId}</>}
        </button>
      </div>
      <div aria-live="polite">
        {recorded ? (
          <p className={styles.decisionStatus}>
            Decision recorded: {recorded === "approve" ? `approve (activate ${pending.repairVersionId})` : `reject (keep ${s.activeVersionId})`}.
            Autopilot applies it on its next check.
          </p>
        ) : null}
        {error ? <p className={styles.decisionError}>Couldn&apos;t send the decision: {error}</p> : null}
      </div>
    </section>
  );
}

// ---------- pipeline strip ----------

function Pipeline({ events, status, monitorEvery }: { events: AutopilotEvent[]; status: Status; monitorEvery: number }) {
  const stages: { id: StageId; name: string; detail: string }[] = [
    { id: "propose", name: "Propose", detail: "a failed request proposes one lesson" },
    { id: "immune", name: "Immune check", detail: `like a known bad lesson? replay its case (${LIMITS.confirmTrials} runs)` },
    { id: "gate", name: "Gate", detail: `fixes its task, breaks nothing (screened, ${LIMITS.screenTrials} runs)` },
    { id: "activate", name: "Activate", detail: "becomes the active version" },
    { id: "monitor", name: "Monitor", detail: `every ${monitorEvery} activations, and when scheduled` },
    { id: "bisect", name: "Bisect", detail: "finds the exact bad lesson" },
    { id: "repair", name: "Repair", detail: "removes only that lesson" },
  ];
  const infos = events.map((e) => ({ e, info: eventInfo(e, status) }));
  const count = (pred: (e: AutopilotEvent, i: EventInfo) => boolean) => infos.filter((x) => pred(x.e, x.info)).length;
  const counts: Record<StageId, string> = {
    propose: `${plural(count((e) => e.type === "training_run"), "request")} · ${count((e) => e.type === "proposed")} proposed`,
    immune: `${count((e) => e.type === "immune_blocked")} blocked · ${count((e) => e.type === "immune_passed" && !!e.recognitionId)} passed`,
    gate: `${count((e) => e.type === "gate_passed")} passed · ${count((e) => e.type === "gate_rejected")} rejected`,
    activate: plural(count((e) => e.type === "activated"), "activation"),
    monitor: `${plural(count((_, i) => i.stage === "monitor"), "check")} · ${plural(count((e) => e.type === "regression_confirmed"), "regression")}`,
    bisect: plural(count((e) => e.type === "investigation_started"), "investigation"),
    repair: `${plural(count((e) => e.type === "repair_activated"), "repair")} activated${status === "awaiting_decision" ? " · 1 waiting" : ""}`,
  };
  const latest = [...infos].reverse().find((x) => x.info.stage !== null);
  const marker = status === "running" ? "now" : status === "awaiting_decision" ? "waiting" : "last step";

  return (
    <ol className={styles.pipeline} aria-label="The autopilot loop">
      {stages.map((st, i) => {
        const current = latest?.info.stage === st.id;
        return (
          <li
            key={st.id}
            className={cx(styles.stage, current && styles.stageCurrent, current && latest && TONE_CLASS[latest.info.tone])}
            aria-current={current ? "step" : undefined}
          >
            {current ? <span className={styles.stageMarker}>{marker}</span> : null}
            <span className={styles.stageName}>
              {i + 1}. {st.name}
            </span>
            <span className={styles.stageDetail}>{st.detail}</span>
            <span className={styles.stageCount}>{counts[st.id]}</span>
            {current && latest ? <span className={styles.stageLast}>{latest.info.text}</span> : null}
          </li>
        );
      })}
    </ol>
  );
}

// ---------- demo plan ----------

function DemoPlan({ view, events }: { view: AutopilotView; events: AutopilotEvent[] }) {
  const s = view.session;
  const stream = s.stream ?? [];
  const plan = events.find((e) => e.type === "session_started" && e.key === "plan");
  const notes = plan
    ? plan.msg
        .replace(/^demo branch:\s*/i, "")
        .split(" · ")
        .map((t) => t.trim())
        .filter(Boolean)
    : [];
  const live = isLive(s.status);
  return (
    <section className="section" aria-labelledby="plan-h">
      <h2 id="plan-h">How this demo was set up</h2>
      <p className="section-lead">
        Besides the agent&apos;s own training requests, the request stream carries a fixed, labelled demo branch. The planted lessons were
        picked by checking which task set covers their failing tasks, never by trying lessons until the demo passes.
      </p>
      {notes.length ? (
        <ul className={styles.planNotes}>
          {notes.map((n, i) => (
            <li key={i}>{n}</li>
          ))}
        </ul>
      ) : (
        <p className="muted">No demo plan was recorded for this session.</p>
      )}
      <p className={styles.setRow}>
        <span className={styles.setName}>Request stream ({plural(stream.length, "item")})</span>
      </p>
      <ol className={styles.stream}>
        {stream.map((item, i) => {
          const d = describeItem(item);
          const done = i < s.position;
          const now = live && i === s.position;
          return (
            <li
              key={i}
              className={cx(styles.streamItem, d.demo && styles.streamDemo, done && styles.streamDone, now && styles.streamNow)}
              title={`${i + 1}: ${d.plain}${done ? " (done)" : now ? " (next)" : ""}`}
              aria-current={now ? "step" : undefined}
            >
              <span className={styles.streamNum}>{i + 1}</span>
              {d.short}
            </li>
          );
        })}
      </ol>
      <p className={styles.setRow}>
        <span className={styles.setName}>Gate set ({s.sets?.gate.length ?? 0})</span>
        {(s.sets?.gate ?? []).map((t) => (
          <code key={t} className={styles.taskChip}>
            {t}
          </code>
        ))}
      </p>
      <p className={styles.setRow}>
        <span className={styles.setName}>Monitoring set ({s.sets?.monitoring.length ?? 0})</span>
        {(s.sets?.monitoring ?? []).map((t) => (
          <code key={t} className={styles.taskChip}>
            {t}
          </code>
        ))}
      </p>
    </section>
  );
}

// ---------- timeline ----------

interface EventGroup {
  key: string;
  pos: number | null; // stream position, or null for session-level events
  auto: boolean; // the automatic monitoring check after an item
  events: AutopilotEvent[];
}

// Consecutive events of one stream item (keys "s<pos>-...", "s<pos>-auto-...") form a group.
function groupEvents(events: AutopilotEvent[]): EventGroup[] {
  const groups: EventGroup[] = [];
  for (const e of events) {
    const m = /^s(\d+)(-auto)?-/.exec(e.key);
    const pos = m ? Number(m[1]) : null;
    const auto = !!m?.[2];
    const id = pos === null ? "session" : `s${pos}${auto ? "-auto" : ""}`;
    const last = groups[groups.length - 1];
    if (last && last.key.split(":")[0] === id) last.events.push(e);
    else groups.push({ key: `${id}:${e.seq}`, pos, auto, events: [e] });
  }
  return groups;
}

function GroupTitle({ g, session, monitorEvery }: { g: EventGroup; session: AutopilotSession; monitorEvery: number }) {
  if (g.pos === null) return <>{g.events.some((e) => e.type === "session_started") ? "Session start" : "Session end"}</>;
  if (g.auto) {
    return (
      <>
        After item {g.pos + 1}: automatic monitoring check <span className={styles.groupNote}>every {monitorEvery} activations</span>
      </>
    );
  }
  const d = describeItem(session.stream?.[g.pos]);
  return (
    <>
      Item {g.pos + 1} of {session.stream?.length ?? "?"}: {d.title}
      {d.note ? <span className={styles.groupNote}>{d.note}</span> : null}
    </>
  );
}

function Timeline({ view, events, monitorEvery }: { view: AutopilotView; events: AutopilotEvent[]; monitorEvery: number }) {
  const s = view.session;
  const t0 = new Date(s.createdAt).getTime();
  const groups = groupEvents(events);
  return (
    <section className="section" aria-labelledby="timeline-h">
      <h2 id="timeline-h">Timeline</h2>
      <p className="section-lead">
        Newest first, grouped by request. Times are minutes:seconds since the session started. Results show their sample size: screened (
        {LIMITS.screenTrials} runs) or confirmed ({LIMITS.confirmTrials} runs).
      </p>
      {groups.length ? (
        <ol className={styles.timeline} aria-label="Events, newest first">
          {[...groups].reverse().map((g) => {
            // Quote the rule once per group, on its newest event (a proposal's message already quotes it).
            const quoted = new Set<string>();
            const rows = [...g.events].reverse().map((e) => {
              const showText = !!e.text && !quoted.has(e.text) && !e.msg.includes(e.text);
              if (e.text) quoted.add(e.text);
              return <EventRow key={e.key} e={e} view={view} t0={t0} showText={showText} />;
            });
            return (
              <li key={g.key} className={styles.group}>
                <h3 className={styles.groupHead}>
                  <GroupTitle g={g} session={s} monitorEvery={monitorEvery} />
                </h3>
                <ol className={styles.events}>{rows}</ol>
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="muted">No events yet.</p>
      )}
    </section>
  );
}

function EventRow({ e, view, t0, showText }: { e: AutopilotEvent; view: AutopilotView; t0: number; showText: boolean }) {
  const s = view.session;
  const info = eventInfo(e, s.status);
  const at = new Date(e.at);
  const train = trainingResult(e);
  // Training runs are saved as `${sessionId}-${key}-t0` (runTrials: `${prefix}-t${n}`); the event doesn't carry the id.
  const trainingRunId = e.type === "training_run" ? `${s.sessionId}-${e.key}-t0` : null;
  const shield = e.type === "immune_blocked" ? "blocked" : e.type === "immune_passed" ? (e.recognitionId ? "passed" : "skipped") : null;

  const meta: { k: string; node: ReactNode }[] = [];
  if (e.taskId && !e.msg.includes(e.taskId)) meta.push({ k: "task", node: <>task <code>{e.taskId}</code></> });
  if (e.versionId && !e.msg.includes(e.versionId)) meta.push({ k: "version", node: <>version <code>{e.versionId}</code></> });
  if (e.lessonId && !e.msg.includes(e.lessonId)) meta.push({ k: "lesson", node: <>lesson <code>{e.lessonId}</code></> });
  if (e.recognitionId) meta.push({ k: "rec", node: <>recognition <code>{e.recognitionId}</code></> });
  if (e.runs !== undefined) meta.push({ k: "runs", node: plural(e.runs, "run") });
  if (e.ms !== undefined) meta.push({ k: "ms", node: `${(e.ms / 1000).toFixed(1)} s` });

  const links: ReactNode[] = [];
  if (trainingRunId) {
    links.push(
      <Link key="run" href={`/runs/${encodeURIComponent(trainingRunId)}`} prefetch={false}>
        Run trace →
      </Link>,
    );
  }
  if (e.investigationId) {
    links.push(
      <Link key="inv" href={`/investigations/${encodeURIComponent(e.investigationId)}`}>
        Investigation {e.investigationId} →
      </Link>,
    );
  }
  if (e.antibodyId) {
    links.push(
      <Link key="ab" href="/immune">
        Antibody {e.antibodyId} in immune memory →
      </Link>,
    );
  }

  const openEvidence = info.tone === "bad" || info.tone === "warn";

  return (
    <li className={cx(styles.event, TONE_CLASS[info.tone], info.strong && styles.eventStrong)}>
      <time className={styles.evTime} dateTime={Number.isNaN(at.getTime()) ? undefined : at.toISOString()} title={dateTime(at)}>
        +{clock(at.getTime() - t0)}
      </time>
      <div className={styles.evMain}>
        <div className={styles.evHead}>
          <span className={cx(styles.type, TYPE_CLASS[info.tone], info.strong && styles.typeStrong)}>
            {shield ? <Shield kind={shield} /> : null}
            {info.text}
          </span>
          {e.label ? <OriginChip origin={e.label} /> : null}
          {train ? <span className={cx(styles.mark, train === "passed" ? "t-good" : "t-bad")}>{train === "passed" ? "✓ passed" : "✗ failed"}</span> : null}
          {meta.length ? (
            <span className={styles.meta}>
              {meta.map((m, i) => (
                <span key={m.k}>
                  {i ? " · " : ""}
                  {m.node}
                </span>
              ))}
            </span>
          ) : null}
        </div>
        {showText && e.text ? <blockquote className={styles.rule}>“{e.text}”</blockquote> : null}
        <p className={styles.msg}>{e.msg}</p>
        {links.length ? <p className={styles.links}>{links}</p> : null}
        {e.evidence?.length ? <EvidenceBlock items={e.evidence} defaultOpen={openEvidence} /> : null}
      </div>
    </li>
  );
}

// ---------- evidence grids ----------

const KIND: Record<EvidenceItem["kind"], { title: string; help: string; order: number }> = {
  trigger: { title: "Triggering task", help: "the task that failed, run again with the lesson", order: 0 },
  replay: { title: "Immune replay", help: "the antibody's failing case, run with this rule", order: 1 },
  gate: { title: "Gate set", help: "a failed screen on a task that passed before is confirmed", order: 2 },
  pinned: { title: "Pinned tests", help: "cases kept from antibodies", order: 3 },
  monitor: { title: "Monitoring set", help: "a failed screen on a task that passed before is confirmed", order: 4 },
  baseline: { title: "Starting point", help: "every gate and monitoring task on the starting version", order: 5 },
};

const LABEL_TONE: Record<Label, Tone> = { GOOD: "good", BAD: "bad", INCONCLUSIVE: "warn" };
const SCREEN: Record<NonNullable<EvidenceItem["status"]>, { text: string; tone: Tone }> = {
  ok: { text: "ok", tone: "good" },
  fail: { text: "fail", tone: "bad" },
  insufficient_evidence: { text: "insufficient evidence", tone: "warn" },
};
const screenInfo = (s: string) => SCREEN[s as keyof typeof SCREEN] ?? { text: s, tone: "neutral" as Tone };

// One task in a grid: its screen (2 runs), and the confirm (5 runs) it escalated to, if any.
interface Cell {
  key: string;
  taskId: string;
  versionId: string;
  screen?: EvidenceItem;
  confirm?: EvidenceItem;
}

interface CellResult {
  text: string;
  tone: Tone;
  rank: number; // problems first
}

function cellResult(c: Cell): CellResult {
  const label = c.confirm?.label;
  if (label) return { text: label, tone: LABEL_TONE[label], rank: label === "BAD" ? 0 : label === "INCONCLUSIVE" ? 1 : 2 };
  const status = c.screen?.status;
  if (status) return { ...screenInfo(status), rank: status === "fail" ? 0 : status === "ok" ? 2 : 1 };
  return { text: "no result", tone: "neutral", rank: 1 };
}

// A failed screen that was not escalated to a confirm (the task wasn't passing before) doesn't count
// against the lesson: it's shown, but not highlighted as a problem.
function uncounted(c: Cell, kind: EvidenceItem["kind"]): boolean {
  return !!c.screen && !c.confirm && c.screen.status !== "ok" && (kind === "gate" || kind === "monitor" || kind === "baseline");
}

const cellRank = (c: Cell, kind: EvidenceItem["kind"]) => (uncounted(c, kind) ? 1.5 : cellResult(c).rank);

function evidenceGroups(items: EvidenceItem[]): { kind: EvidenceItem["kind"]; cells: Cell[] }[] {
  const byKind = new Map<EvidenceItem["kind"], Cell[]>();
  items.forEach((it, i) => {
    let cells = byKind.get(it.kind);
    if (!cells) {
      cells = [];
      byKind.set(it.kind, cells);
    }
    if (it.status !== undefined) {
      cells.push({ key: `${it.taskId}-${i}`, taskId: it.taskId, versionId: it.versionId, screen: it });
      return;
    }
    // A confirm follows the screen it escalated (same task and version), when there was one.
    const open = [...cells].reverse().find((c) => c.taskId === it.taskId && c.versionId === it.versionId && c.screen && !c.confirm);
    if (open) open.confirm = it;
    else cells.push({ key: `${it.taskId}-${i}`, taskId: it.taskId, versionId: it.versionId, confirm: it });
  });
  return [...byKind.entries()]
    .sort((a, b) => (KIND[a[0]]?.order ?? 9) - (KIND[b[0]]?.order ?? 9))
    .map(([kind, cells]) => ({ kind, cells: [...cells].sort((a, b) => cellRank(a, kind) - cellRank(b, kind)) }));
}

const TALLY_ORDER = ["BAD", "fail", "INCONCLUSIVE", "insufficient evidence", "no result", "GOOD", "ok"];

function groupSummary(kind: EvidenceItem["kind"], cells: Cell[]): string {
  const title = KIND[kind]?.title ?? kind;
  if (cells.length === 1) return `${title}: ${cellResult(cells[0]).text}`;
  const counted = new Map<string, number>();
  const notCounted = new Map<string, number>();
  for (const c of cells) {
    const m = uncounted(c, kind) && kind !== "baseline" ? notCounted : counted;
    const t = cellResult(c).text;
    m.set(t, (m.get(t) ?? 0) + 1);
  }
  const tally = [
    ...TALLY_ORDER.filter((t) => counted.has(t)).map((t) => `${counted.get(t)} ${t}`),
    ...TALLY_ORDER.filter((t) => notCounted.has(t)).map((t) => `${notCounted.get(t)} ${t} (not counted)`),
  ].join(", ");
  return `${title} (${cells.length} tasks): ${tally}`;
}

function screenCounts(c: Counts, trials: number): string {
  const parts = [`${c.pass}/${trials} passed`];
  const failed = c.targetFail + c.otherFail;
  if (failed) parts.push(`${failed} failed`);
  if (c.error) parts.push(plural(c.error, "infra error"));
  return parts.join(" · ");
}

const COUNTS_HELP =
  "target fail: failed the check being confirmed · other fail: failed a different check · error: infrastructure error, not counted as pass or fail";

function EvidenceBlock({ items, defaultOpen }: { items: EvidenceItem[]; defaultOpen: boolean }) {
  const groups = evidenceGroups(items);
  const runs = items.reduce((n, it) => n + (it.trials ?? 0), 0);
  return (
    <details className={styles.evidence} open={defaultOpen}>
      <summary>
        <span className={styles.evidenceTitle}>Evidence</span> · {groups.map((g) => groupSummary(g.kind, g.cells)).join(" · ")}{" "}
        <span className="sample">({plural(runs, "run")})</span>
      </summary>
      <div className={styles.evidenceBody}>
        {groups.map((g) => (
          <div key={g.kind}>
            <h4 className={styles.egTitle}>
              {KIND[g.kind]?.title ?? g.kind} <span className={styles.egHelp}>· {KIND[g.kind]?.help}</span>
            </h4>
            <ul className={styles.grid}>
              {g.cells.map((c) => (
                <EvidenceCell key={c.key} cell={c} kind={g.kind} />
              ))}
            </ul>
          </div>
        ))}
      </div>
    </details>
  );
}

function EvidenceCell({ cell, kind }: { cell: Cell; kind: EvidenceItem["kind"] }) {
  const r = cellResult(cell);
  const sc = cell.screen;
  const cf = cell.confirm;
  const skip = uncounted(cell, kind);
  const note = !skip ? null : kind === "baseline" ? "not passing at the start" : "not confirmed: it wasn't passing before, so it doesn't count";
  return (
    <li className={cx(styles.cell, !skip && CELL_CLASS[r.tone])}>
      <code className={styles.cellTask} title={`${cell.taskId} on ${cell.versionId}`}>
        {cell.taskId}
      </code>
      {sc?.status ? (
        <div className={styles.cellLine}>
          <span className={`chip chip-${screenInfo(sc.status).tone}`}>{screenInfo(sc.status).text}</span>
          <span className="sample">screened ({sc.trials})</span>
          <span className={styles.counts}>{screenCounts(sc.counts, sc.trials)}</span>
          <RunLinks runIds={sc.runIds} label={cf ? "screen" : "runs"} />
        </div>
      ) : null}
      {cf ? (
        <>
          <div className={styles.cellLine}>
            {sc ? (
              <>
                <span aria-hidden="true">→</span>
                <span className="sr-only">then</span>
              </>
            ) : null}
            {cf.label ? <span className={`chip chip-${LABEL_TONE[cf.label]}`}>{cf.label}</span> : null}
            <span className="sample">confirmed ({cf.trials})</span>
          </div>
          <div className={styles.counts} title={COUNTS_HELP}>
            pass {cf.counts.pass} · target fail {cf.counts.targetFail} · other fail {cf.counts.otherFail} · error {cf.counts.error}
          </div>
          <RunLinks runIds={cf.runIds} label={sc ? "confirm" : "runs"} />
        </>
      ) : null}
      {note ? <span className={styles.cellNote}>{note}</span> : null}
    </li>
  );
}

// ---------- the list page (/autopilot) ----------

interface SessionRow {
  sessionId: string;
  status: string;
  activeVersionId: string;
  activations: number;
  createdAt: string;
  finishedAt?: string | null;
}

type ListState = { kind: "loading" } | { kind: "error"; message: string } | { kind: "ready"; rows: SessionRow[] };

export function AutopilotHome({ monitorEvery }: { monitorEvery: number }) {
  const router = useRouter();
  const [list, setList] = useState<ListState>({ kind: "loading" });
  const [nonce, setNonce] = useState(0);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch("/api/autopilot", { cache: "no-store" });
        if (!res.ok) throw new Error(await errorText(res));
        const rows = (await res.json()) as unknown;
        if (!cancelled) setList({ kind: "ready", rows: Array.isArray(rows) ? (rows as SessionRow[]) : [] });
      } catch (e) {
        if (!cancelled) setList({ kind: "error", message: e instanceof Error ? e.message : String(e) });
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [nonce]);

  const reload = () => {
    setList({ kind: "loading" });
    setNonce((n) => n + 1);
  };

  const start = async () => {
    setStarting(true);
    setStartError(null);
    try {
      const res = await fetch("/api/autopilot", { method: "POST" });
      const body = (await res.json().catch(() => null)) as { sessionId?: unknown; error?: unknown } | null;
      if (!res.ok) {
        const msg = typeof body?.error === "string" ? body.error : `HTTP ${res.status} ${res.statusText}`.trim();
        throw new Error(res.status === 409 ? `Can't start yet: ${msg}.` : `Couldn't start autopilot: ${msg}`);
      }
      if (typeof body?.sessionId !== "string" || !body.sessionId) throw new Error("Couldn't start autopilot: the server didn't return a session id.");
      router.push(`/autopilot/${encodeURIComponent(body.sessionId)}`); // stays "Starting…" while the page loads
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setStartError(/^(Can't|Couldn't)/.test(msg) ? msg : `Couldn't start autopilot: ${msg}`);
      setStarting(false);
    }
  };

  const running = list.kind === "ready" ? list.rows.find((r) => isLive(r.status)) : undefined;

  return (
    <main className="report">
      <header className="report-head">
        <p className="eyebrow">
          <Link href="/">Bisect</Link> · the learning loop, running on its own
        </p>
        <h1>Autopilot</h1>
        <p className="lead">
          Autopilot runs a self-improving support agent&apos;s whole learning loop with no clicks, and Bisect watches over it.
        </p>
        <ol className={styles.loop}>
          <li>Each training request runs on the active version of the agent. If it fails, the agent proposes one short lesson.</li>
          <li>
            <strong>Immune check:</strong> if the lesson resembles a known bad lesson, that lesson&apos;s failing case is replayed with{" "}
            {LIMITS.confirmTrials} fresh runs; a bad replay blocks it.
          </li>
          <li>
            <strong>Gate:</strong> the lesson must fix the task that triggered it ({LIMITS.confirmTrials} of {LIMITS.confirmTrials} runs) and
            not break the gate set or pinned tests (screened, {LIMITS.screenTrials} runs each). Then it becomes the active version.
          </li>
          <li>
            <strong>Monitor:</strong> every {monitorEvery} activations, and at scheduled points, the monitoring set is checked. A confirmed
            regression makes Bisect start itself: it finds the exact bad lesson, records an antibody, and removes only that lesson, or asks a
            person first when removing it would break something.
          </li>
        </ol>
        <p className={styles.intro}>
          The demo branch is labelled honestly: <OriginChip origin="planted" /> is a harmful lesson submitted through the gate on purpose,{" "}
          <OriginChip origin="injected" /> skipped the gate, and <OriginChip origin="natural" /> means the agent wrote it.
        </p>
      </header>

      <div className={styles.startRow}>
        <button type="button" className={styles.startButton} onClick={() => void start()} disabled={starting}>
          {starting ? "Starting…" : "Start autopilot demo"}
        </button>
        <span className="muted">
          {running ? (
            <>
              Session <Link href={`/autopilot/${encodeURIComponent(running.sessionId)}`}>{running.sessionId}</Link> is already running; starting
              opens it.
            </>
          ) : (
            "Only one session runs at a time; if one is running, this opens it."
          )}
        </span>
      </div>
      {startError ? (
        <div className={cx("notice notice-bad", styles.startError)} role="alert">
          {startError}
        </div>
      ) : null}

      <section className="section" aria-labelledby="sessions-h">
        <div className={styles.listHead}>
          <h2 id="sessions-h">Sessions</h2>
          <button type="button" className={styles.smallButton} onClick={reload}>
            Refresh
          </button>
        </div>
        {list.kind === "loading" ? (
          <p className="muted" aria-busy="true">
            Loading sessions…
          </p>
        ) : list.kind === "error" ? (
          <div className="notice notice-bad" role="alert">
            <p>Couldn&apos;t load the sessions: {list.message}</p>
          </div>
        ) : list.rows.length === 0 ? (
          <p className="muted">No sessions yet. Start the demo above.</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Session</th>
                <th scope="col">Status</th>
                <th scope="col">Active version</th>
                <th scope="col">Activations</th>
                <th scope="col">Started</th>
              </tr>
            </thead>
            <tbody>
              {list.rows.map((r) => {
                const st = statusInfo(r.status);
                return (
                  <tr key={r.sessionId}>
                    <td data-label="Session">
                      <Link href={`/autopilot/${encodeURIComponent(r.sessionId)}`}>
                        <code>{r.sessionId}</code>
                      </Link>
                    </td>
                    <td className="td-short" data-label="Status">
                      <span className={`chip chip-${st.tone}`}>{st.text}</span>
                    </td>
                    <td className="td-short" data-label="Active version">
                      <code>{r.activeVersionId}</code>
                    </td>
                    <td className="td-short" data-label="Activations">
                      {fmt(r.activations ?? 0)}
                    </td>
                    <td data-label="Started">
                      {dateTime(r.createdAt)}
                      {r.finishedAt ? <div className="cell-help">finished {dateTime(r.finishedAt)}</div> : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
}
