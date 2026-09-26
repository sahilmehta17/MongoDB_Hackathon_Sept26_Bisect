"use client";

// The results page for one investigation. Loads GET /api/investigations/[id], polls every 2 s while
// the investigation is running, and explains every step in plain language. It shows only numbers
// that are in the data, always with their sample size. By default it shows the short story
// (cards, search strip, with/without, re-check line); everything else is under "Show all evidence".
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { Counts, Investigation, InvestigationView, Label, Origin, Probe, RecheckRow, Verdict } from "@/lib/types";
import { LIMITS } from "@/lib/types";
import styles from "./report.module.css";

const POLL_MS = 2000;

type Tone = "good" | "bad" | "warn" | "info" | "neutral";

// ---------- loading ----------

type LoadState =
  | { kind: "loading" }
  | { kind: "notfound" }
  | { kind: "error"; message: string }
  | { kind: "ready"; view: InvestigationView; fetchedAt: number; stale: string | null };

async function errorText(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body.error === "string") return `${body.error} (HTTP ${res.status})`;
  } catch {
    // not JSON; fall through
  }
  return `HTTP ${res.status} ${res.statusText}`.trim();
}

function useInvestigation(id: string) {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let hadData = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const res = await fetch(`/api/investigations/${encodeURIComponent(id)}`, { cache: "no-store" });
        if (cancelled) return;
        if (res.status === 404) {
          setState({ kind: "notfound" });
          return;
        }
        if (!res.ok) throw new Error(await errorText(res));
        const view = (await res.json()) as InvestigationView;
        if (cancelled) return;
        hadData = true;
        setState({ kind: "ready", view, fetchedAt: Date.now(), stale: null });
        if (view.investigation.verdict === "running") timer = setTimeout(load, POLL_MS);
      } catch (e) {
        if (cancelled) return;
        const message = e instanceof Error ? e.message : String(e);
        if (hadData) {
          // Keep showing the last good data and keep trying while it was running.
          setState((prev) => (prev.kind === "ready" ? { ...prev, stale: message } : prev));
          timer = setTimeout(load, POLL_MS);
        } else {
          setState({ kind: "error", message });
        }
      }
    };
    void load();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [id, attempt]);

  const retry = useCallback(() => {
    setState({ kind: "loading" });
    setAttempt((n) => n + 1);
  }, []);
  return { state, retry };
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

// ---------- wording ----------

const ORIGIN_TEXT: Record<Origin, string> = {
  planted: "planted test case",
  natural: "learned by the agent itself",
  seeded: "hand-written useful lesson",
  injected: "injected (bypassed the gate)",
  visitor: "submitted by a visitor",
};

const VERDICT: Record<Verdict, { text: string; tone: Tone }> = {
  running: { text: "Running…", tone: "info" },
  verified: { text: "Verified", tone: "good" },
  inconclusive: { text: "Inconclusive", tone: "warn" },
  baseline_not_reproduced: { text: "Failure not reproduced", tone: "warn" },
  budget_exceeded: { text: "Stopped: run budget used up", tone: "warn" },
  error: { text: "Stopped by an error", tone: "bad" },
};

const TRIGGER_TEXT: Record<string, string> = {
  manual: "started by hand",
  monitor: "started by the monitor",
  autopilot: "started by autopilot",
};

const PHASE_TEXT: Record<Probe["phase"], string> = {
  endpoint: "endpoint check",
  search: "search step",
  scan: "scan",
  verify: "verification",
  recheck: "re-check",
  pinned: "pinned test",
  replay: "immune replay",
  gate: "gate check",
  monitor: "monitoring check",
};

const LABEL_TONE: Record<Label, Tone> = { GOOD: "good", BAD: "bad", INCONCLUSIVE: "warn" };

function sampleTag(trials: number): string {
  if (trials >= LIMITS.confirmTrials) return `confirmed (${trials})`;
  if (trials === LIMITS.screenTrials) return `screened (${trials})`;
  return `${trials} run${trials === 1 ? "" : "s"}`;
}

const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;

// Counts about the rule under investigation (the failing task).
function targetCountsText(c: Counts, trials: number): string {
  const parts: string[] = [];
  if (c.targetFail > 0) parts.push(`${c.targetFail}/${trials} broke the rule`);
  if (c.pass > 0 || c.targetFail === 0) parts.push(`${c.pass}/${trials} passed`);
  if (c.otherFail > 0) parts.push(`${c.otherFail} failed another check`);
  if (c.error > 0) parts.push(plural(c.error, "infra error"));
  return parts.join(" · ");
}

// Counts for any task (re-checks): passed every check or not.
function checkCountsText(c: Counts, trials: number): string {
  const parts = [`${c.pass}/${trials} passed`];
  const failed = c.targetFail + c.otherFail;
  if (failed > 0) parts.push(`${failed} failed`);
  if (c.error > 0) parts.push(plural(c.error, "infra error"));
  return parts.join(" · ");
}

function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

const fmt = (n: number) => n.toLocaleString("en-US");

// ---------- small pieces ----------

function Chip({ tone = "neutral", children }: { tone?: Tone; children: React.ReactNode }) {
  return <span className={`chip chip-${tone}`}>{children}</span>;
}

function LabelChip({ label }: { label: Label }) {
  return <Chip tone={LABEL_TONE[label]}>{label}</Chip>;
}

function RunLinks({ runIds }: { runIds: string[] }) {
  if (!runIds.length) return null;
  return (
    <span className="runs">
      <span className="runs-label">runs</span>
      {runIds.map((r, i) => (
        <Link key={r} href={`/runs/${encodeURIComponent(r)}`} title={`Run ${r}`} aria-label={`Run ${r}`}>
          {i + 1}
        </Link>
      ))}
    </span>
  );
}

function ProbeResult({ probe, mode }: { probe: Probe; mode: "target" | "checks" }) {
  const text = mode === "target" ? targetCountsText(probe.counts, probe.trials) : checkCountsText(probe.counts, probe.trials);
  // Re-check cells are narrow: keep the run links on the same line there.
  return (
    <div className="probe">
      <div className="probe-line">
        <LabelChip label={probe.label} />
        <span className="probe-counts">{text}</span>
        <span className="sample">{sampleTag(probe.trials)}</span>
        {mode === "checks" ? <RunLinks runIds={probe.runIds} /> : null}
      </div>
      {mode === "target" ? <RunLinks runIds={probe.runIds} /> : null}
    </div>
  );
}

function Section({ id, title, children, lead }: { id: string; title: string; lead?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="section" aria-labelledby={id}>
      <h2 id={id}>{title}</h2>
      {lead ? <p className="section-lead">{lead}</p> : null}
      {children}
    </section>
  );
}

// ---------- the page ----------

export default function InvestigationReport({ id }: { id: string }) {
  const { state, retry } = useInvestigation(id);
  const running = state.kind === "ready" && state.view.investigation.verdict === "running";
  const now = useNow(running);

  if (state.kind === "loading") {
    return (
      <main className="report" aria-busy="true">
        <p className="status-msg">Loading investigation {id}…</p>
      </main>
    );
  }
  if (state.kind === "notfound") {
    return (
      <main className="report">
        <div className="notice notice-warn">
          <h1>No investigation with that id</h1>
          <p>
            Nothing is saved under <code>{id}</code>. Check the link, or <Link href="/">go to the start page</Link>.
          </p>
        </div>
      </main>
    );
  }
  if (state.kind === "error") {
    return (
      <main className="report">
        <div className="notice notice-bad" role="alert">
          <h1>Couldn&apos;t load investigation {id}</h1>
          <p>{state.message}</p>
          <button type="button" className="button" onClick={retry}>
            Try again
          </button>
        </div>
      </main>
    );
  }

  const { view, fetchedAt, stale } = state;
  const elapsed = view.elapsedMs + (running && now > fetchedAt ? now - fetchedAt : 0);
  return <Report view={view} elapsedMs={elapsed} stale={stale} />;
}

function Report({ view, elapsedMs, stale }: { view: InvestigationView; elapsedMs: number; stale: string | null }) {
  const inv = view.investigation;
  const running = inv.verdict === "running";
  const rule = view.houseRules[inv.targetAssertion];
  const task = view.tasks[inv.failureTaskId];
  const verdict = VERDICT[inv.verdict] ?? { text: inv.verdict, tone: "neutral" as Tone };

  return (
    <main className={`report ${styles.page}`}>
      {stale ? (
        <div className="notice notice-warn" role="status">
          Couldn&apos;t refresh ({stale}). Showing the last data received; retrying every {POLL_MS / 1000} s.
        </div>
      ) : null}

      <header className="report-head">
        <p className="eyebrow">
          <Link href="/">Bisect</Link> · investigation of a self-improving agent
        </p>
        <div className="title-row">
          <h1>Investigation {inv.investigationId}</h1>
          <span className={`badge badge-${verdict.tone}`}>
            {running ? <span className="pulse" aria-hidden="true" /> : null}
            {verdict.text}
            {running ? <span className="badge-timer">{clock(elapsedMs)}</span> : null}
          </span>
        </div>
        {inv.summary ? <p className="lead">{inv.summary}</p> : null}
        {inv.hidden ? <p className="notice notice-warn">Not listed on the home page: {inv.hidden.reason}.</p> : null}
        <dl className="facts">
          <div>
            <dt>Failing task</dt>
            <dd>
              <code>{inv.failureTaskId}</code>
              {task ? <span className="muted"> · {task.workflow.replace("_", " ")}</span> : null}
              {task ? <blockquote className="request">“{task.request}”</blockquote> : null}
            </dd>
          </div>
          <div>
            <dt>House rule it breaks</dt>
            <dd>
              {rule ? <strong>{rule.text}</strong> : null} <code className="muted">{inv.targetAssertion}</code>
            </dd>
          </div>
          <div>
            <dt>Versions searched</dt>
            <dd>
              <code>{inv.goodVersionId}</code> (good) to <code>{inv.badVersionId}</code> (bad) · {plural(inv.line.length, "version")} ·
              history <code>{inv.historyId}</code> · {TRIGGER_TEXT[inv.trigger] ?? inv.trigger}
            </dd>
          </div>
        </dl>
      </header>

      <SummaryCards view={view} />
      <SearchStrip view={view} />
      <WithWithout view={view} />
      <RecheckLine view={view} />
      {inv.antibodyId ? (
        <section className="antibody" aria-label="Antibody">
          <p className="antibody-title">
            Antibody <code>{inv.antibodyId}</code> created → this bad habit is now blocked on sight
          </p>
          <p>
            <Link href="/immune">See immune memory →</Link>
          </p>
        </section>
      ) : null}

      {/* Everything that used to be on the page is still here, one click away. */}
      <details className={`${styles.disclosure} ${styles.allEvidence}`}>
        <summary>
          <span className={styles.whenClosed}>Show all evidence ▸</span>
          <span className={styles.whenOpen}>Hide the evidence ▾</span>
        </summary>
        <div className={styles.allEvidenceBody}>
          <Steps view={view} />
          <Timeline view={view} />
          <Evidence view={view} />
          <Repair view={view} />
          <CostPanel view={view} elapsedMs={elapsedMs} />
          <RawLog view={view} />
        </div>
      </details>
    </main>
  );
}

// ---------- progress steps ----------

const EXPECTED: Record<string, Label> = { parent: "GOOD", introducing: "BAD", current: "BAD", current_minus_suspect: "GOOD" };

// The probe for one configuration. Probes are appended as they finish, so when a scan led to a
// second verification round, the last one is the round for the current suspect.
function configProbe(inv: Investigation, config: string): Probe | undefined {
  return inv.verification.findLast((p) => p.config === config);
}

// The conviction rule: all four configurations were run and each came out as expected.
function fourWayMatched(inv: Investigation): boolean {
  return Object.entries(EXPECTED).every(([c, want]) => configProbe(inv, c)?.label === want);
}

function Steps({ view }: { view: InvestigationView }) {
  const inv = view.investigation;
  const endpoint = (v: string) => inv.probes.find((p) => p.phase === "endpoint" && p.versionId === v);
  const verifiedAll = fourWayMatched(inv);
  const steps: { name: string; detail: string; done: boolean }[] = [
    {
      name: "Reproduce",
      detail: "early version GOOD, current BAD",
      done: endpoint(inv.goodVersionId)?.label === "GOOD" && endpoint(inv.badVersionId)?.label === "BAD",
    },
    { name: "Search", detail: "binary search for the version that broke it", done: inv.suspect !== null },
    { name: "Verify", detail: "4 configurations, 5 fresh runs each", done: verifiedAll },
    { name: "Repair", detail: "new version without only that lesson", done: inv.repairVersionId !== null },
    { name: "Re-check", detail: "other tasks, before vs after", done: inv.acceptance !== null },
  ];
  const firstOpen = steps.findIndex((s) => !s.done);
  return (
    <ol className="steps" aria-label="Investigation steps">
      {steps.map((s, i) => {
        let status: { text: string; tone: Tone };
        if (s.done && s.name === "Re-check" && inv.acceptance === "awaiting_decision") status = { text: "needs a decision", tone: "warn" };
        else if (s.done) status = { text: "done", tone: "good" };
        else if (i === firstOpen) status = inv.verdict === "running" ? { text: "in progress", tone: "info" } : { text: "stopped here", tone: "warn" };
        else status = { text: inv.verdict === "running" ? "waiting" : "not reached", tone: "neutral" };
        return (
          <li key={s.name} className={`step step-${status.tone}`}>
            <span className="step-num">{i + 1}</span>
            <span className="step-body">
              <span className="step-name">{s.name}</span>
              <span className="step-detail">{s.detail}</span>
              <span className="step-status">{status.text}</span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

// ---------- summary cards ----------

function SummaryCards({ view }: { view: InvestigationView }) {
  const inv = view.investigation;
  const rule = view.houseRules[inv.targetAssertion];
  const badEndpoint = inv.probes.find((p) => p.phase === "endpoint" && p.versionId === inv.badVersionId);
  const gt = view.groundTruth;
  const suspect = inv.suspect;
  const verifyDone = inv.verification.length === 4;
  const verifyMatched = fourWayMatched(inv);

  let causeStatus: string;
  if (!suspect) causeStatus = "";
  else if (inv.verdict === "verified") causeStatus = "Verified: all four checks matched.";
  else if (inv.verdict === "running") causeStatus = !verifyDone
        ? "Suspect, being verified now…"
        : verifyMatched
          ? "All four checks matched."
          : "Suspect only: verification did not convict it.";
  else causeStatus = "Suspect only: verification did not convict it.";

  let fixTone: Tone = "neutral";
  let fixHead: string;
  let fixBody: React.ReactNode = null;
  if (inv.acceptance === "accepted") {
    fixTone = "good";
    fixHead = "Removed only this lesson; everything else still passes.";
    fixBody = (
      <>
        Repair version <code>{inv.repairVersionId}</code> · {plural(inv.recheck.length, "task")} re-checked
        {inv.pinned.length ? <>, {plural(inv.pinned.length, "pinned test")}</> : null}.
      </>
    );
  } else if (inv.acceptance === "awaiting_decision") {
    fixTone = "warn";
    fixHead = "Fix needs a decision.";
    fixBody = inv.broken.length ? (
      <>
        Removing the lesson changed {plural(inv.broken.length, "task")} that passed before:{" "}
        {inv.broken.map((t, i) => (
          <span key={t}>
            {i ? ", " : ""}
            <code>{t}</code>
          </span>
        ))}
        . A person decides whether to apply repair <code>{inv.repairVersionId}</code>.
      </>
    ) : (
      <>The repair did not meet the acceptance bar, so a person decides whether to apply it.</>
    );
  } else if (inv.verdict === "running") {
    fixHead = inv.repairVersionId ? "Checking the repair…" : "Not yet.";
    fixBody = inv.repairVersionId ? (
      <>
        Repair <code>{inv.repairVersionId}</code> is being re-checked on other tasks.
      </>
    ) : (
      <>A fix is only made after the cause is verified.</>
    );
  } else if (inv.verdict === "verified") {
    fixHead = "Cause verified; no repair decision recorded.";
  } else {
    fixHead = "No change made.";
    fixBody =
      inv.verdict === "inconclusive"
        ? "The evidence didn't meet the bar, so nothing was removed."
        : inv.verdict === "baseline_not_reproduced"
          ? "The failure could not be reproduced reliably, so there was nothing to fix."
          : inv.verdict === "budget_exceeded"
            ? "The run budget ran out before a verdict."
            : "The investigation stopped on an error; see the log below.";
  }

  return (
    <div className="cards">
      <article className="card card-bad">
        <h2 className="card-kicker">{badEndpoint && badEndpoint.label !== "BAD" ? "Problem (reported, not reproduced)" : "Problem"}</h2>
        <p className="card-head">
          {rule ? `The agent ${rule.wrong}.` : <>The agent fails the check <code>{inv.targetAssertion}</code>.</>}
        </p>
        <p className="card-body">
          On task <code>{inv.failureTaskId}</code>
          {badEndpoint ? (
            <>
              , at <code>{badEndpoint.versionId}</code>: {targetCountsText(badEndpoint.counts, badEndpoint.trials)} ·{" "}
              <span className="sample">{sampleTag(badEndpoint.trials)}</span>
            </>
          ) : null}
          .
        </p>
      </article>

      <article className={`card ${suspect ? "card-warn" : ""}`}>
        <h2 className="card-kicker">Cause</h2>
        {suspect ? (
          <>
            <blockquote className="card-quote">“{suspect.text}”</blockquote>
            <p className="card-body">
              Lesson <code>{suspect.lessonId}</code> added in <code>{suspect.versionId}</code> ·{" "}
              <Chip tone={suspect.origin === "natural" || suspect.origin === "seeded" ? "neutral" : "warn"}>
                {ORIGIN_TEXT[suspect.origin] ?? suspect.origin}
              </Chip>
            </p>
            <p className="card-body">{causeStatus}</p>
            {gt ? (
              <p className={`card-body gt ${gt.versionId === suspect.versionId ? "gt-match" : "gt-miss"}`}>
                {gt.versionId === suspect.versionId
                  ? `✓ Matches the planted answer (${gt.versionId}, lesson ${gt.lessonId}).`
                  : `✗ The planted answer was ${gt.versionId} (lesson ${gt.lessonId}).`}
              </p>
            ) : null}
          </>
        ) : (
          <p className="card-head">
            {inv.verdict === "running"
              ? "Searching the version history…"
              : inv.verdict === "baseline_not_reproduced"
                ? "Not searched: the failure did not reproduce."
                : "No suspect found."}
          </p>
        )}
      </article>

      <article className={`card card-${fixTone}`}>
        <h2 className="card-kicker">Fix</h2>
        <p className="card-head">{fixHead}</p>
        {fixBody ? <p className="card-body">{fixBody}</p> : null}
      </article>
    </div>
  );
}

// ---------- the short story: search strip, with/without, re-check line ----------

const GLYPH: Record<Label, string> = { GOOD: "✓", BAD: "✗", INCONCLUSIVE: "?" };
const WORD: Record<Label, string> = { GOOD: "passes", BAD: "fails", INCONCLUSIVE: "inconclusive" };
const DOT_TONE: Record<Label, string> = { GOOD: styles.good, BAD: styles.bad, INCONCLUSIVE: styles.warn };

function originTone(origin: Origin): Tone {
  return origin === "natural" || origin === "seeded" ? "neutral" : "warn";
}

// Every version of the searched line in a row (left: the early, good end; right: today), one dot per
// version: filled where the failing task was run on it, hollow where it wasn't.
function SearchStrip({ view }: { view: InvestigationView }) {
  const inv = view.investigation;
  const line = inv.line;
  if (!line.length) return null;
  const running = inv.verdict === "running";
  const convicted = fourWayMatched(inv);

  // Probes per version, in the order they finished; search and scan steps numbered in that order.
  const probesOf = new Map<string, Probe[]>();
  const stepOf = new Map<string, number>();
  let searchSteps = 0;
  let scanSteps = 0;
  for (const p of inv.probes) {
    probesOf.set(p.versionId, [...(probesOf.get(p.versionId) ?? []), p]);
    if (p.phase === "search" || p.phase === "scan") {
      if (p.phase === "search") searchSteps++;
      else scanSteps++;
      if (!stepOf.has(p.versionId)) stepOf.set(p.versionId, stepOf.size + 1);
    }
  }
  const tested = line.filter((v) => probesOf.has(v.versionId)).length;
  const n = line.length;
  const first = line[0].versionId;
  const last = line[n - 1].versionId;
  const endLabel = (v: string) => probesOf.get(v)?.findLast((p) => p.phase === "endpoint")?.label;

  // While running, the search is over once there is a suspect (verification comes next).
  const caption =
    running && !inv.suspect
      ? `Searching ${plural(n, "version")}, tested ${tested} so far`
      : inv.verdict === "baseline_not_reproduced"
        ? `${plural(n, "version")} in range, tested ${tested}`
        : `Searched ${plural(n, "version")}, tested ${tested}`;

  let how: string;
  if (inv.verdict === "baseline_not_reproduced") {
    const g = endLabel(first);
    const b = endLabel(last);
    how =
      g && g !== "GOOD"
        ? `The early version ${first} did not pass (${WORD[g]}), so no search ran.`
        : `The failure did not reproduce on ${last}${b ? ` (${WORD[b]})` : ""}, so no search ran.`;
  } else if (searchSteps + scanSteps > 0) {
    const steps = [plural(searchSteps, "search step"), scanSteps ? plural(scanSteps, "scan step") : ""].filter(Boolean).join(" and ");
    how = `Both ends first, then ${steps}, numbered in the order they ran.`;
  } else if (n === 2 && tested === 2) {
    how = "Both ends tested; they are neighbors, so no search was needed.";
  } else {
    how = running ? "Testing both ends first…" : "Both ends tested.";
  }

  const present = new Set<Label>();
  let untested = 0;
  // A long line keeps every dot but only labels the versions that matter, so it stays readable.
  const dense = n > 12;

  const items = line.map((v, i) => {
    const probes = probesOf.get(v.versionId) ?? [];
    const latest = probes.at(-1);
    if (latest) present.add(latest.label);
    else untested++;
    const isSuspect = inv.suspect?.versionId === v.versionId;
    const labelled = !dense || latest !== undefined || isSuspect || i === 0 || i === n - 1;
    const step = stepOf.get(v.versionId);
    const lesson = v.lessonId ? view.lessons[v.lessonId] : undefined;
    const top = step !== undefined ? String(step) : i === 0 ? "earlier" : i === n - 1 ? "today" : "";
    const title = [
      v.versionId,
      lesson ? `adds “${lesson.text}” (${ORIGIN_TEXT[lesson.origin] ?? lesson.origin})` : v.index === 0 ? "starting point" : "",
      probes.length
        ? probes.map((p) => `${PHASE_TEXT[p.phase] ?? p.phase}: ${targetCountsText(p.counts, p.trials)}`).join("; ")
        : "not tested",
    ]
      .filter(Boolean)
      .join(" · ");
    return (
      <li
        key={v.versionId}
        className={`${styles.ver} ${i === 0 ? styles.verFirst : ""} ${i === n - 1 ? styles.verLast : ""} ${isSuspect ? styles.suspect : ""}`}
        title={title}
      >
        <span className={`${styles.top} ${step !== undefined ? styles.stepNo : ""}`} aria-hidden="true">
          {top}
        </span>
        <span className={styles.dotRow} aria-hidden="true">
          <span className={`${styles.dot} ${latest ? DOT_TONE[latest.label] : styles.hollow}`}>{latest ? GLYPH[latest.label] : ""}</span>
        </span>
        <span className={labelled ? styles.vid : "sr-only"}>{v.versionId}</span>
        {isSuspect ? (
          <span className={styles.tag} aria-hidden="true">
            {convicted ? "cause" : "suspect"}
          </span>
        ) : null}
        <span className="sr-only">
          {latest ? `: ${WORD[latest.label]}` : ": not tested"}
          {step !== undefined ? `, step ${step}` : ""}
          {isSuspect ? (convicted ? ", the cause" : ", the suspect") : ""}
        </span>
      </li>
    );
  });

  const suspect = inv.suspect;
  return (
    <section className={styles.block} aria-labelledby="search-strip">
      <h2 id="search-strip">{caption}</h2>
      <p className={styles.sub}>{how}</p>
      <div className={styles.stripScroll}>
        <ol className={`${styles.strip} ${dense ? styles.dense : ""}`} aria-label={`Versions from ${first} (earlier) to ${last} (today)`}>
          {items}
        </ol>
      </div>
      <p className={styles.legend} aria-hidden="true">
        {(["GOOD", "BAD", "INCONCLUSIVE"] as Label[])
          .filter((l) => present.has(l))
          .map((l) => (
            <span key={l} className={styles.legendItem}>
              <span className={`${styles.dot} ${styles.dotSmall} ${DOT_TONE[l]}`}>{GLYPH[l]}</span> {WORD[l]}
            </span>
          ))}
        {untested ? (
          <span className={styles.legendItem}>
            <span className={`${styles.dot} ${styles.dotSmall} ${styles.hollow}`} /> not tested
          </span>
        ) : null}
      </p>
      {suspect ? (
        <div className={styles.rule}>
          <p className={styles.ruleHead}>
            <strong className={styles.tBad}>{suspect.versionId}</strong> {convicted ? "added the rule that broke it" : "added the suspected rule"}{" "}
            <Chip tone={originTone(suspect.origin)}>{ORIGIN_TEXT[suspect.origin] ?? suspect.origin}</Chip>
          </p>
          <blockquote className={styles.quote}>“{suspect.text}”</blockquote>
        </div>
      ) : null}
    </section>
  );
}

const ROWS: { config: NonNullable<Probe["config"]>; name: string }[] = [
  { config: "parent", name: "Before the rule" },
  { config: "introducing", name: "Rule added" },
  { config: "current", name: "Today" },
  { config: "current_minus_suspect", name: "Today without the rule" },
];

// What a configuration showed, in words, from its actual label and counts.
function observedText(p: Probe): string {
  if (p.label === "GOOD") return `passes ${p.counts.pass}/${p.trials}`;
  if (p.label === "BAD") return `fails ${p.counts.targetFail}/${p.trials}`;
  return `inconclusive, ${p.counts.pass}/${p.trials} passed`;
}

// The four-way verification as four plain rows.
function WithWithout({ view }: { view: InvestigationView }) {
  const inv = view.investigation;
  if (!inv.suspect && !inv.verification.length) return null;
  const running = inv.verdict === "running";
  const allDone = ROWS.every((r) => configProbe(inv, r.config));
  const matched = fourWayMatched(inv);

  return (
    <section className={styles.block} aria-labelledby="with-without">
      <h2 id="with-without">With and without the rule</h2>
      <ul className={styles.rows}>
        {ROWS.map((r) => {
          const p = configProbe(inv, r.config);
          if (!p) {
            return (
              <li key={r.config} className={styles.row}>
                <span className={styles.rowMark} aria-hidden="true">
                  <span className={`${styles.dot} ${styles.dotSmall} ${styles.hollow}`} />
                </span>
                <span className={styles.rowText}>
                  <strong>{r.name}</strong>: <span className="muted">{running ? "running…" : "not run"}</span>
                </span>
              </li>
            );
          }
          const want = EXPECTED[r.config];
          return (
            <li key={r.config} className={styles.row}>
              <span className={styles.rowMark} aria-hidden="true">
                <span className={`${styles.dot} ${styles.dotSmall} ${DOT_TONE[p.label]}`}>{GLYPH[p.label]}</span>
              </span>
              <span className={styles.rowText}>
                <strong>{r.name}</strong>: {observedText(p)} <span className={styles.rowVersion}>({p.versionId})</span>
                {p.label !== want ? <span className={styles.tWarn}> · expected to {want === "GOOD" ? "pass" : "fail"}</span> : null}
                {p.counts.error ? <span className={styles.tWarn}> · {plural(p.counts.error, "infra error")}</span> : null}
              </span>
              <span className={styles.rowRuns}>
                <RunLinks runIds={p.runIds} />
              </span>
            </li>
          );
        })}
      </ul>
      {allDone && matched ? (
        <p className={`${styles.conclusion} ${styles.tGood}`}>All four as expected, so this rule is the cause.</p>
      ) : allDone && !running ? (
        <p className={`${styles.conclusion} ${styles.tWarn}`}>Not all four as expected, so the rule is not convicted and nothing was removed.</p>
      ) : null}
    </section>
  );
}

// One line on the repair, with the re-check table one click away.
function RecheckLine({ view }: { view: InvestigationView }) {
  const inv = view.investigation;
  if (!inv.repairVersionId) return null;
  const running = inv.verdict === "running";
  const others = inv.recheck.filter((r) => r.taskId !== inv.failureTaskId);
  const passedBefore = others.filter((r) => r.before.label === "GOOD");
  const stillPass = passedBefore.filter((r) => r.after.label === "GOOD").length;
  const nowPass = others.filter((r) => r.before.label !== "GOOD" && r.after.label === "GOOD").length;
  const failingAfter = inv.recheck.find((r) => r.taskId === inv.failureTaskId)?.after.label;

  let tone: string;
  let text: React.ReactNode;
  if (inv.acceptance === "accepted") {
    tone = styles.tGood;
    text = (
      <>
        Removed only that rule.{" "}
        {passedBefore.length
          ? `${stillPass} of ${plural(passedBefore.length, "other task")} still ${passedBefore.length === 1 ? "passes" : "pass"}.`
          : "No other re-checked task was passing before."}
        {nowPass ? ` ${nowPass} more that failed before now ${nowPass === 1 ? "passes" : "pass"} too.` : ""}
      </>
    );
  } else if (inv.acceptance === "awaiting_decision") {
    tone = styles.tWarn;
    text = inv.broken.length
      ? `Removing it would break ${plural(inv.broken.length, "other task")} that passed before: needs a person.`
      : failingAfter && failingAfter !== "GOOD"
        ? "Removing it did not fix the failing task: needs a person."
        : "The repair did not meet the acceptance bar: needs a person.";
  } else if (running) {
    tone = styles.tInfo;
    const planned = inv.recheckTaskIds?.length;
    text = `Removed only that rule in a new version; re-checking tasks${planned ? ` (${inv.recheck.length} of ${planned} done)` : ""}…`;
  } else {
    tone = "muted";
    text = "A repair was made, but no decision was recorded.";
  }

  const beforeV = inv.recheck[0]?.before.versionId ?? inv.badVersionId;
  return (
    <section className={styles.block} aria-label="Repair">
      <p className={`${styles.recheckLine} ${tone}`}>{text}</p>
      {inv.recheck.length ? (
        <details className={styles.disclosure}>
          <summary>
            <span className={styles.whenClosed}>Show the re-check ▸</span>
            <span className={styles.whenOpen}>Hide the re-check ▾</span>
          </summary>
          <div className={styles.disclosureBody}>
            <RecheckTable rows={inRecheckOrder(inv)} view={view} beforeV={beforeV} afterV={inv.repairVersionId} />
          </div>
        </details>
      ) : null}
    </section>
  );
}

// ---------- version timeline ----------

function Timeline({ view }: { view: InvestigationView }) {
  const inv = view.investigation;
  const gt = view.groundTruth;
  const probedVersions = new Set(inv.probes.map((p) => p.versionId));
  const convicted = fourWayMatched(inv);
  const lead = (
    <>
      Each version adds one lesson. Bisect ran the failing task on {probedVersions.size} of {inv.line.length} versions
      {inv.suspect ? " to find where it broke" : ""}.
      {gt ? (
        <>
          {" "}
          The <strong>planted answer</strong> (known in advance, for testing) is <code>{gt.versionId}</code>.
        </>
      ) : null}
    </>
  );
  return (
    <Section id="timeline" title="Version history" lead={lead}>
      <ol className="timeline">
        {inv.line.map((v) => {
          const lesson = v.lessonId ? view.lessons[v.lessonId] : undefined;
          const probes = inv.probes.filter((p) => p.versionId === v.versionId);
          const isSuspect = inv.suspect?.versionId === v.versionId;
          const cls = [
            "tl-item",
            isSuspect ? "tl-suspect" : "",
            v.versionId === inv.goodVersionId ? "tl-good" : "",
            v.versionId === inv.badVersionId ? "tl-bad" : "",
          ].join(" ");
          return (
            <li key={v.versionId} className={cls}>
              <div className="tl-version">
                <code>{v.versionId}</code>
              </div>
              <div className="tl-main">
                <div className="tl-markers">
                  {v.versionId === inv.goodVersionId ? <Chip tone="good">known good</Chip> : null}
                  {v.versionId === inv.badVersionId ? <Chip tone="bad">current (bad)</Chip> : null}
                  {isSuspect ? <Chip tone="bad">{convicted ? "introduced the problem" : "suspect"}</Chip> : null}
                  {gt?.versionId === v.versionId ? <Chip tone="info">planted answer</Chip> : null}
                </div>
                <p className="tl-lesson">
                  {v.lessonId ? (
                    <>
                      <span className="muted">adds </span>
                      <code>{v.lessonId}</code> {lesson ? <>“{lesson.text}”</> : null}
                      {lesson ? <span className="tl-origin"> · {ORIGIN_TEXT[lesson.origin] ?? lesson.origin}</span> : null}
                    </>
                  ) : (
                    <span className="muted">{v.index === 0 ? "Starting point" : "No lesson added"}</span>
                  )}
                </p>
                {probes.length ? (
                  probes.map((p) => (
                    <div key={p.key} className="tl-probe">
                      <span className="tl-phase">{PHASE_TEXT[p.phase] ?? p.phase}</span>
                      {p.taskId !== inv.failureTaskId ? <code className="muted"> {p.taskId}</code> : null}
                      <ProbeResult probe={p} mode="target" />
                    </div>
                  ))
                ) : (
                  <p className="tl-untested">not tested</p>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </Section>
  );
}

// ---------- four-way evidence ----------

const CONFIGS: { config: NonNullable<Probe["config"]>; name: string; help: string }[] = [
  { config: "parent", name: "Just before the lesson", help: "the version before it was added" },
  { config: "introducing", name: "The lesson just added", help: "the version that added it" },
  { config: "current", name: "Today's agent", help: "the current version, with the lesson" },
  {
    config: "current_minus_suspect",
    name: "Today's agent, lesson hidden",
    help: "same lessons, only this one removed; nothing swapped in",
  },
];

function Evidence({ view }: { view: InvestigationView }) {
  const inv = view.investigation;
  const byConfig = (c: string) => configProbe(inv, c);
  const cur = byConfig("current");
  const minus = byConfig("current_minus_suspect");
  const running = inv.verdict === "running";

  if (!inv.suspect && !inv.verification.length) {
    return (
      <Section id="evidence" title="Proof: four configurations">
        <p className="muted">{running ? "Runs once a suspect is found." : "Not run: no suspect was found."}</p>
      </Section>
    );
  }

  // Infra errors aren't evidence either way: say so instead of letting "0/5" read as "harmless".
  const errs = (p: Probe) => (p.counts.error ? ` (${p.counts.error} of ${p.trials} runs hit infrastructure errors)` : "");
  const lead =
    cur && minus ? (
      <strong className="headline">
        {cur.counts.error || minus.counts.error ? "Not enough evidence. " : ""}
        With the lesson: {cur.counts.targetFail}/{cur.trials} runs broke the rule{errs(cur)}. Without it:{" "}
        {minus.counts.targetFail}/{minus.trials}
        {errs(minus)}.
      </strong>
    ) : (
      "The suspect is convicted only if all four configurations come out as expected."
    );
  const allDone = CONFIGS.every((c) => byConfig(c.config));
  const allMatch = fourWayMatched(inv);

  return (
    <Section id="evidence" title="Proof: four configurations" lead={lead}>
      <table className="table">
        <thead>
          <tr>
            <th scope="col">Configuration</th>
            <th scope="col">Version</th>
            <th scope="col">Expected</th>
            <th scope="col">Observed (fresh runs)</th>
            <th scope="col">Match</th>
          </tr>
        </thead>
        <tbody>
          {CONFIGS.map((c) => {
            const p = byConfig(c.config);
            const expected = EXPECTED[c.config];
            const match = p ? p.label === expected : null;
            return (
              <tr key={c.config} className={match === false ? "row-bad" : ""}>
                <td data-label="Configuration">
                  <strong>{c.name}</strong>
                  <div className="cell-help">{c.help}</div>
                </td>
                <td className="td-short" data-label="Version">
                  {p ? (
                    <>
                      <code>{p.versionId}</code>
                      {c.config === "current_minus_suspect" && inv.suspect ? (
                        <>
                          {" "}
                          without <code>{inv.suspect.lessonId}</code>
                        </>
                      ) : null}
                    </>
                  ) : (
                    "–"
                  )}
                </td>
                <td className="td-short" data-label="Expected">
                  <LabelChip label={expected} />
                </td>
                <td data-label="Observed">
                  {p ? <ProbeResult probe={p} mode="target" /> : <span className="muted">{running ? "pending…" : "not run"}</span>}
                </td>
                <td className="td-short" data-label="Match">
                  {match === null ? (
                    <span className="muted">–</span>
                  ) : match ? (
                    <span className="mark mark-good">✓ as expected</span>
                  ) : (
                    <span className="mark mark-bad">✗ not as expected</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {allDone ? (
        <p className={`verdict-line ${allMatch ? "verdict-good" : "verdict-warn"}`}>
          {allMatch
            ? "All four matched, so this lesson is convicted as the cause."
            : "Not all four matched, so the lesson is not convicted. Nothing was removed on this evidence."}
        </p>
      ) : null}
    </Section>
  );
}

// ---------- repair and re-check ----------

function change(row: RecheckRow): { text: string; tone: Tone } {
  const b = row.before.label;
  const a = row.after.label;
  if (b === a) return { text: "same", tone: "neutral" };
  if (a === "GOOD") return { text: "now passes", tone: "good" };
  if (b === "GOOD") return { text: "broke", tone: "bad" };
  return { text: "changed", tone: "warn" };
}

function RecheckTable({ rows, view, beforeV, afterV }: { rows: RecheckRow[]; view: InvestigationView; beforeV: string; afterV: string }) {
  return (
    <table className="table">
      <thead>
        <tr>
          <th scope="col">Task</th>
          <th scope="col">Why checked</th>
          <th scope="col">Before ({beforeV})</th>
          <th scope="col">After ({afterV})</th>
          <th scope="col">Change</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const ch = change(r);
          const t = view.tasks[r.taskId];
          return (
            <tr key={r.taskId + r.before.key} className={ch.tone === "neutral" ? "" : `row-${ch.tone}`}>
              <td data-label="Task">
                <code title={t?.request}>{r.taskId}</code>
                <div className="cell-help">
                  {t ? t.workflow.replace("_", " ") : ""}
                  {r.taskId === view.investigation.failureTaskId ? " · the failing task" : ""}
                </div>
              </td>
              <td data-label="Why checked">{r.reason}</td>
              <td data-label={`Before (${beforeV})`}>
                <ProbeResult probe={r.before} mode="checks" />
              </td>
              <td data-label={`After (${afterV})`}>
                <ProbeResult probe={r.after} mode="checks" />
              </td>
              <td className="td-short" data-label="Change">
                <Chip tone={ch.tone}>{ch.text}</Chip>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function Repair({ view }: { view: InvestigationView }) {
  const inv = view.investigation;
  const running = inv.verdict === "running";
  if (!inv.repairVersionId) {
    return (
      <Section id="repair" title="Repair and re-check">
        <p className="muted">
          {running ? "A repair is made once the cause is verified." : "No repair was made: the cause was not verified."}
        </p>
      </Section>
    );
  }
  const beforeV = inv.recheck[0]?.before.versionId ?? inv.badVersionId;
  const afterV = inv.repairVersionId;
  const counts = { same: 0, fixed: 0, broke: 0, changed: 0 };
  for (const r of inv.recheck) {
    const c = change(r).text;
    if (c === "same") counts.same++;
    else if (c === "now passes") counts.fixed++;
    else if (c === "broke") counts.broke++;
    else counts.changed++;
  }
  const suspectAt = inv.line.findIndex((l) => l.versionId === inv.suspect?.versionId);
  const parentV = suspectAt > 0 ? inv.line[suspectAt - 1].versionId : null;
  const laterLessons = suspectAt >= 0 ? inv.line.slice(suspectAt + 1).filter((l) => l.lessonId).length : 0;
  const lead = (
    <>
      Repair <code>{afterV}</code> is <code>{inv.badVersionId}</code> with only lesson <code>{inv.suspect?.lessonId ?? "?"}</code>{" "}
      removed; every other lesson stays.
      {parentV && laterLessons ? (
        <>
          {" "}
          A rollback to <code>{parentV}</code> would also have thrown away the {plural(laterLessons, "lesson")} added after{" "}
          <code>{inv.suspect?.versionId}</code>.
        </>
      ) : null}
    </>
  );
  return (
    <Section id="repair" title="Repair and re-check" lead={lead}>
      {inv.recheck.length ? (
        <>
          <p className="summary-line">
            {plural(inv.recheck.length, "task")} re-checked on the current version and on the repair:{" "}
            <strong>{counts.same} same</strong>, <strong className="t-good">{counts.fixed} now pass</strong>,{" "}
            <strong className={counts.broke ? "t-bad" : ""}>{counts.broke} broke</strong>
            {counts.changed ? (
              <>
                , <strong className="t-warn">{counts.changed} changed</strong>
              </>
            ) : null}
            .
          </p>
          <RecheckTable rows={inRecheckOrder(inv)} view={view} beforeV={beforeV} afterV={afterV} />
        </>
      ) : (
        <p className="muted">{running ? "Re-checking other tasks…" : "No re-check rows recorded."}</p>
      )}

      <h3>Pinned tests</h3>
      {inv.pinned.length ? (
        <>
          <p className="section-lead">Cases kept from earlier antibodies, run again on the repair.</p>
          <RecheckTable rows={inv.pinned} view={view} beforeV={inv.pinned[0]?.before.versionId ?? beforeV} afterV={afterV} />
        </>
      ) : (
        <p className="muted">None{running && inv.acceptance === null ? " yet" : ""}.</p>
      )}

      {inv.acceptance === "accepted" ? (
        <p className="verdict-line verdict-good">
          Repair accepted: every task that passed before still passes on <code>{afterV}</code>.
        </p>
      ) : inv.acceptance === "awaiting_decision" ? (
        <p className="verdict-line verdict-warn">
          Awaiting a decision:{" "}
          {inv.broken.length ? (
            <>
              {plural(inv.broken.length, "task")} that passed before {inv.broken.length === 1 ? "does" : "do"} not pass on{" "}
              <code>{afterV}</code>: {inv.broken.join(", ")}.
            </>
          ) : (
            <>the repair did not meet the acceptance bar.</>
          )}{" "}
          The repair was not applied automatically.
        </p>
      ) : running ? (
        <p className="verdict-line verdict-info">Re-check in progress…</p>
      ) : null}
    </Section>
  );
}

// ---------- cost ----------

function CostPanel({ view, elapsedMs }: { view: InvestigationView; elapsedMs: number }) {
  const c = view.cost;
  const tiles: { label: string; value: string; note?: string }[] = [
    { label: "Agent runs", value: fmt(c.runs), note: `limit ${fmt(LIMITS.maxRuns)}` },
    { label: "Model calls", value: fmt(c.modelCalls), note: `limit ${fmt(LIMITS.maxModelCalls)}` },
    { label: "Tokens", value: fmt(c.tokens) },
    { label: "Infra errors", value: fmt(c.errors) },
    { label: "Elapsed", value: clock(elapsedMs), note: view.investigation.verdict === "running" ? "still running" : undefined },
  ];
  return (
    <Section id="cost" title="Cost and time">
      <dl className="tiles">
        {tiles.map((t) => (
          <div key={t.label} className="tile">
            <dt>{t.label}</dt>
            <dd>
              <span className="tile-value">{t.value}</span>
              {t.note ? <span className="tile-note">{t.note}</span> : null}
            </dd>
          </div>
        ))}
      </dl>
    </Section>
  );
}

// ---------- raw log ----------

function RawLog({ view }: { view: InvestigationView }) {
  const inv = view.investigation;
  const start = new Date(inv.startedAt).getTime();
  return (
    <details className="rawlog">
      <summary>Raw log ({plural(inv.log.length, "entry", "entries")})</summary>
      <ol>
        {inv.log.map((e, i) => {
          const t = new Date(e.at);
          return (
            <li key={i}>
              <time dateTime={t.toISOString()} title={t.toISOString()}>
                +{clock(t.getTime() - start)}
              </time>
              <span>{e.msg}</span>
            </li>
          );
        })}
      </ol>
    </details>
  );
}

// Re-check rows in the frozen order (the failing task first), not the order their runs finished.
function inRecheckOrder(inv: InvestigationView["investigation"]) {
  const order = inv.recheckTaskIds ?? [];
  const rank = (id: string) => (order.indexOf(id) === -1 ? order.length : order.indexOf(id));
  return [...inv.recheck].sort((a, b) => rank(a.taskId) - rank(b.taskId));
}
