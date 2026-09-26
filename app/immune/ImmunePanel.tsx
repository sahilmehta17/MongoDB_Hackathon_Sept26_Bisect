"use client";

// Everything live on /immune: the first-vs-repeat headline, "Propose a rule" (the booth game),
// the latest result, antibodies, pinned tests and the recognition feed. Every number shown is read
// from GET /api/immune or the POST /api/immune/propose response; nothing is estimated here.
import Link from "next/link";
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import type { ImmuneView, Label, Origin, Probe, Recognition } from "@/lib/types";
import styles from "./immune.module.css";

const VIEW_URL = "/api/immune";
const PROPOSE_URL = "/api/immune/propose";
const POLL_MS = 5000;
const MAX_CHARS = 200; // same limit as the propose route
const CALIBRATING = "Immune memory is being calibrated; try again shortly.";

type AntibodyView = ImmuneView["antibodies"][number];
type Replay = Recognition["replays"][number];

const ORIGIN_LABEL: Record<Origin, string> = {
  planted: "planted test case",
  natural: "learned by the agent itself",
  injected: "injected (bypassed the gate)",
  visitor: "submitted by a visitor",
  seeded: "hand-written lesson",
};

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");

// ms → "12.4 s" under a minute, "1 min 50 s" above.
function fmtMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "?";
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return s ? `${m} min ${s} s` : `${m} min`;
}

const fmtScore = (s: number) => s.toFixed(2);
const fmtRatio = (r: number) => (r < 10 ? r.toFixed(1).replace(/\.0$/, "") : String(Math.round(r)));
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
const humanize = (assertion: string) => assertion.replace(/_/g, " ");

function fmtClock(d: Date | string): string {
  const t = new Date(d);
  return Number.isNaN(t.getTime()) ? "?" : t.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s;
}

async function errorText(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
  const status = `${res.status}${res.statusText ? ` ${res.statusText}` : ""}`;
  return typeof body?.error === "string" ? `${body.error} (${status})` : `the server answered ${status}`;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

function ShieldIcon({ className }: { className?: string }) {
  return (
    <svg className={cx(styles.shield, className)} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M12 2.2 4.2 5.1v6.1c0 4.9 3.3 9.2 7.8 10.6 4.5-1.4 7.8-5.7 7.8-10.6V5.1L12 2.2Z" fill="currentColor" />
      <path d="m8.4 12.1 2.5 2.5 4.8-5" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// ---------------------------------------------------------------------------------------------

export default function ImmunePanel() {
  const [view, setView] = useState<ImmuneView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      const res = await fetch(VIEW_URL, { cache: "no-store", signal });
      if (!res.ok) throw new Error(await errorText(res));
      const data = (await res.json()) as ImmuneView;
      setView(data);
      setLoadError(null);
      setUpdatedAt(Date.now());
    } catch (e) {
      if (!signal?.aborted) setLoadError(message(e));
    }
  }, []);

  // Poll every 5 s so the feed and counters move when other people submit (paused while hidden).
  useEffect(() => {
    const ctrl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let first = true;
    const tick = async () => {
      if (first || !document.hidden) await refresh(ctrl.signal);
      first = false;
      if (!ctrl.signal.aborted) timer = setTimeout(tick, POLL_MS);
    };
    void tick();
    return () => {
      ctrl.abort();
      clearTimeout(timer);
    };
  }, [refresh]);

  if (!view) {
    return loadError ? (
      <div className={styles.error} role="alert">
        <strong>Couldn&apos;t load immune memory.</strong>
        {loadError}. Retrying every {POLL_MS / 1000} s.
      </div>
    ) : (
      <p className={styles.muted}>Loading immune memory…</p>
    );
  }

  return (
    <>
      {loadError && (
        <p className={styles.staleNote} role="status">
          Couldn&apos;t refresh ({loadError}). Showing data from {updatedAt ? fmtClock(new Date(updatedAt)) : "earlier"}; retrying every{" "}
          {POLL_MS / 1000} s.
        </p>
      )}
      <Headline view={view} />
      <PinnedStrip view={view} />
      <Propose view={view} onDecided={() => void refresh()} />
      <Antibodies view={view} />
      <Feed view={view} />
      {updatedAt && (
        <p className={styles.updated}>
          Updated {fmtClock(new Date(updatedAt))} · refreshes every {POLL_MS / 1000} s
        </p>
      )}
    </>
  );
}

// ---------- headline: first catch vs repeat catch ----------

function Headline({ view }: { view: ImmuneView }) {
  const { repeat } = view.headline;
  // headline.first is only filled once something has been blocked. Before that, show the latest
  // conviction's own first catch (the same saved numbers, read from its antibody). Never pair a
  // repeat with a different antibody's first catch.
  let first = view.headline.first;
  if (!first) {
    const ab = repeat
      ? view.antibodies.find((a) => a.antibodyId === repeat.antibodyId)
      : [...view.antibodies].reverse().find((a) => a.firstCatch);
    if (ab?.firstCatch) first = { investigationId: ab.investigationId, antibodyId: ab.antibodyId, ms: ab.firstCatch.ms, runs: ab.firstCatch.runs };
  }
  const ratio =
    first && repeat && first.antibodyId === repeat.antibodyId && repeat.ms > 0 && repeat.runs > 0
      ? { faster: first.ms / repeat.ms, fewerRuns: first.runs / repeat.runs }
      : null;

  return (
    <section className={styles.hero} aria-labelledby="immune-headline">
      <h2 id="immune-headline" className={styles.srOnly}>
        First catch versus repeat catch
      </h2>
      <div className={styles.heroGrid}>
        <div className={styles.heroCell}>
          <p className={styles.heroKicker}>First catch</p>
          <p className={styles.heroSub}>a full investigation</p>
          {first ? (
            <>
              <p className={styles.heroBig}>{fmtMs(first.ms)}</p>
              <p className={styles.heroRuns}>{plural(first.runs, "run")}</p>
              <p className={styles.heroMeta}>
                {first.antibodyId} found and proven by{" "}
                <Link href={`/investigations/${first.investigationId}`} prefetch={false}>
                  investigation {first.investigationId}
                </Link>
              </p>
            </>
          ) : (
            <p className={styles.heroPending}>not measured yet</p>
          )}
        </div>
        <div className={styles.heroVs} aria-hidden="true">
          vs
        </div>
        <div className={cx(styles.heroCell, styles.heroRepeat)}>
          <p className={styles.heroKicker}>Repeat catch</p>
          <p className={styles.heroSub}>one replay of the proven case</p>
          {repeat ? (
            <>
              <p className={styles.heroBig}>{fmtMs(repeat.ms)}</p>
              <p className={styles.heroRuns}>{plural(repeat.runs, "run")}</p>
              <p className={styles.heroMeta}>
                a rule resembling {repeat.antibodyId} (similarity {fmtScore(repeat.similarity)}), blocked in {repeat.recognitionId}
              </p>
            </>
          ) : (
            <>
              <p className={styles.heroPending}>not measured yet</p>
              <p className={styles.heroMeta}>Nothing has been blocked yet. Try a reworded bad rule below.</p>
            </>
          )}
        </div>
      </div>
      {ratio && ratio.faster > 1 && ratio.fewerRuns > 1 && (
        <p className={styles.heroRatio}>
          The repeat catch was <strong>{fmtRatio(ratio.faster)}× faster</strong> and used{" "}
          <strong>{fmtRatio(ratio.fewerRuns)}× fewer runs</strong>.
        </p>
      )}
    </section>
  );
}

function PinnedStrip({ view }: { view: ImmuneView }) {
  const n = view.pinnedCount;
  return (
    <div className={styles.pinned}>
      <ShieldIcon />
      <div>
        {n > 0 ? (
          <span className={styles.pinnedMain}>
            <span className={styles.pinnedCount}>{n}</span> pinned {n === 1 ? "test guards" : "tests guard"} every future change
          </span>
        ) : (
          <span className={styles.pinnedMain}>No pinned tests yet: the first proven bad lesson will add one.</span>
        )}
        <span className={styles.pinnedMeta}>
          {plural(view.antibodies.length, "antibody", "antibodies")} ·{" "}
          {view.threshold === null ? "similarity threshold not calibrated yet" : `similarity threshold ${fmtScore(view.threshold)}`}
        </span>
      </div>
    </div>
  );
}

// ---------- propose a rule (booth game) ----------

type SubmitError = { status: number | null; message: string };

function Propose({ view, onDecided }: { view: ImmuneView; onDecided: () => void }) {
  const [draft, setDraft] = useState("");
  const [baseChoice, setBaseChoice] = useState<string>("");
  const [pending, setPending] = useState<{ text: string; startedAt: number } | null>(null);
  const [now, setNow] = useState(0);
  const [result, setResult] = useState<Recognition | null>(null);
  const [error, setError] = useState<SubmitError | null>(null);

  const calibrated = view.threshold !== null;
  // Keep the visitor's choice while it's still offered; otherwise the first (best) version.
  const baseVersionId = view.baseVersions.some((b) => b.versionId === baseChoice) ? baseChoice : (view.baseVersions[0]?.versionId ?? "");
  const text = draft.replace(/\s+/g, " ").trim();
  const over = draft.length > MAX_CHARS;
  const canSubmit = calibrated && !pending && !!text && !over && !!baseVersionId;

  useEffect(() => {
    if (!pending) return;
    const id = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(id);
  }, [pending]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    const startedAt = Date.now();
    setNow(startedAt);
    setPending({ text, startedAt });
    setResult(null);
    setError(null);
    try {
      const res = await fetch(PROPOSE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, baseVersionId }),
      });
      if (!res.ok) setError({ status: res.status, message: await errorText(res) });
      else setResult((await res.json()) as Recognition);
    } catch (err) {
      setError({ status: null, message: message(err) });
    } finally {
      setPending(null);
      onDecided();
    }
  }

  const elapsed = pending ? Math.max(0, now - pending.startedAt) : 0;

  return (
    <section className={styles.section} aria-labelledby="propose-title">
      <h2 id="propose-title" className={styles.sectionTitle}>
        Propose a rule: can you sneak a bad one past it?
      </h2>
      <p className={styles.sectionLede}>
        Pick a prewritten rule or write your own. If it looks like a known bad habit, Bisect adds it to the agent and replays that
        habit&apos;s failing case with 5 fresh runs. It is blocked only if the replay fails.
      </p>
      <div className={styles.card}>
        {!calibrated && <p className={styles.notice}>{CALIBRATING}</p>}
        <form onSubmit={submit}>
          <fieldset className={styles.fieldset} disabled={!calibrated || !!pending}>
            <div>
              <label className={styles.fieldLabel} htmlFor="immune-base">
                Agent version to add the rule to
              </label>
              {view.baseVersions.length ? (
                <select id="immune-base" className={styles.select} value={baseVersionId} onChange={(e) => setBaseChoice(e.target.value)}>
                  {view.baseVersions.map((b) => (
                    <option key={b.versionId} value={b.versionId}>
                      {b.label}
                    </option>
                  ))}
                </select>
              ) : (
                <p className={styles.muted}>No agent versions are available yet.</p>
              )}
            </div>

            {view.menu.length > 0 && (
              <div>
                <span className={styles.fieldLabel} id="immune-menu-label">
                  Prewritten rules
                </span>
                <ul className={styles.menu} aria-labelledby="immune-menu-label">
                  {view.menu.map((m) => (
                    <li key={m.text}>
                      <button
                        type="button"
                        className={cx(styles.menuItem, draft === m.text && styles.menuItemActive)}
                        aria-pressed={draft === m.text}
                        onClick={() => setDraft(m.text)}
                      >
                        <span className={cx(styles.tag, m.kind === "reworded bad rule" ? styles.tagBad : styles.tagGood)}>{m.kind}</span>
                        <span>{m.text}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div>
              <label className={styles.fieldLabel} htmlFor="immune-text">
                {view.menu.length ? "…or write your own" : "Your rule"}
              </label>
              <textarea
                id="immune-text"
                className={styles.textarea}
                value={draft}
                maxLength={MAX_CHARS}
                rows={3}
                placeholder="Write a rule for the support agent, e.g. about refunds, timeouts or addresses."
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  // Cmd/Ctrl+Enter submits; plain Enter stays a newline (the server folds it into a space).
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    e.currentTarget.form?.requestSubmit();
                  }
                }}
              />
              <div className={styles.counterRow}>
                <span>Your rule is labeled &ldquo;visitor&rdquo;.</span>
                <span className={cx(over && styles.counterOver)} aria-live="polite">
                  {draft.length}/{MAX_CHARS}
                </span>
              </div>
            </div>

            <div className={styles.actions}>
              <button type="submit" className={styles.button} disabled={!canSubmit}>
                {pending ? "Checking…" : "Check this rule"}
              </button>
              {draft && !pending && (
                <button type="button" className={styles.linkButton} onClick={() => setDraft("")}>
                  Clear
                </button>
              )}
            </div>
          </fieldset>
        </form>

        <div aria-live="polite">
          {pending && (
            <div className={styles.progress} role="status">
              <div className={styles.progressHead}>
                <p className={styles.progressTitle}>Checking your rule…</p>
                <span className={styles.timer}>{(elapsed / 1000).toFixed(1)} s</span>
              </div>
              <p className={styles.quote}>&ldquo;{pending.text}&rdquo;</p>
              <div className={styles.progressBar} />
              <p className={styles.progressNote}>
                Searching antibodies… replaying the known failing case with your rule, 5 fresh runs…
              </p>
              <ol className={cx(styles.steps, styles.small)}>
                <li>Atlas Vector Search compares your rule with every antibody.</li>
                <li>If one looks similar, the agent re-runs that antibody&apos;s failing case 5 times with your rule added.</li>
                <li>Blocked only if the replay fails; otherwise it goes on to the normal gate.</li>
              </ol>
            </div>
          )}
          {error && (
            <div className={styles.error} role="alert">
              <strong>{error.status === 409 ? CALIBRATING : "Your rule couldn't be checked."}</strong>
              {error.status === 400 ? "The server rejected it: " : error.status === null ? "Network error: " : ""}
              {error.message}
            </div>
          )}
          {result && <ResultCard rec={result} view={view} />}
        </div>
      </div>
    </section>
  );
}

// ---------- result of the latest submission ----------

function labelWord(label: Label): string {
  if (label === "BAD") return "failed";
  if (label === "GOOD") return "passed";
  return "inconclusive";
}

function ReplayBlock({ replay, view, text }: { replay: Replay; view: ImmuneView; text: string }) {
  const { probe } = replay;
  const ab = view.antibodies.find((a) => a.antibodyId === replay.antibodyId);
  return (
    <div className={styles.replay}>
      <div className={styles.tags}>
        <strong>{replay.antibodyId}</strong>
        <span className={styles.tag}>similarity {fmtScore(replay.score)}</span>
        <span className={cx(styles.tag, probe.label === "BAD" ? styles.tagBad : probe.label === "GOOD" ? styles.tagGood : styles.tagWarn)}>
          replay {labelWord(probe.label)}
          {probe.label === "INCONCLUSIVE" ? "" : ` (${probe.label})`}
        </span>
        <span className={styles.tag}>confirmed ({probe.trials})</span>
      </div>
      <p className={styles.replayCounts}>
        {text}: <span className={styles.big}>{probe.counts.targetFail}/{probe.trials}</span> failed
        {ab ? (
          <>
            {" "}
            the house rule <code className={styles.code}>{ab.targetAssertion}</code>
          </>
        ) : null}{" "}
        on task <code className={styles.code}>{probe.taskId}</code>
      </p>
      <CountsNote counts={probe.counts} />
      <RunLinks probe={probe} />
    </div>
  );
}

function CountsNote({ counts }: { counts: Probe["counts"] }) {
  const parts = [
    counts.pass ? `${counts.pass} passed everything` : "",
    counts.otherFail ? `${counts.otherFail} failed a different check` : "",
    counts.error ? `${plural(counts.error, "infrastructure error")}` : "",
  ].filter(Boolean);
  return parts.length ? <p className={styles.countsNote}>{parts.join(" · ")}</p> : null;
}

function RunLinks({ probe }: { probe: Probe }) {
  if (!probe.runIds.length) return null;
  return (
    <ul className={styles.runLinks} aria-label="Replay runs">
      {probe.runIds.map((id, i) => (
        <li key={id}>
          <Link href={`/runs/${encodeURIComponent(id)}`} prefetch={false} title={id}>
            run {i + 1}
          </Link>
        </li>
      ))}
    </ul>
  );
}

function ResultCard({ rec, view }: { rec: Recognition; view: ImmuneView }) {
  const blocker = rec.replays.find((r) => r.antibodyId === rec.blockedBy);
  let title: string;
  let sub: ReactNode;
  let tone: string | undefined;

  if (rec.decision === "immune_blocked") {
    tone = styles.resultBlocked;
    title = `Blocked in ${fmtMs(rec.ms)}`;
    sub = (
      <>
        This is a known bad habit ({rec.blockedBy}).
        {blocker && (
          <>
            {" "}
            Replay: {blocker.probe.counts.targetFail}/{blocker.probe.trials} failed with your rule.
          </>
        )}
      </>
    );
  } else if (rec.decision === "immune_passed") {
    tone = styles.resultPassed;
    title = "Allowed through to the normal gate";
    const allGood = rec.replays.every((r) => r.probe.label === "GOOD");
    const who = rec.replays.map((r) => `${r.antibodyId} (similarity ${fmtScore(r.score)})`).join(" and ");
    sub = allGood ? (
      <>
        Resembled {who || "a known bad habit"} but passed {rec.replays.length > 1 ? "their cases" : "its case"}.
      </>
    ) : (
      <>
        Resembled {who || "a known bad habit"}, but {rec.replays.length > 1 ? "no replay proved it bad" : "the replay was inconclusive"}, and
        weak evidence never blocks.
      </>
    );
  } else {
    title = "No known bad habit matched";
    sub = (
      <>
        No antibody scored at or above the similarity threshold ({fmtScore(rec.threshold)}), so nothing needed replaying. The rule goes to
        the normal gate.
      </>
    );
  }

  return (
    <article className={cx(styles.result, tone)} aria-labelledby="immune-result-title">
      <h3 id="immune-result-title" className={styles.resultTitle}>
        {rec.decision === "immune_blocked" && <ShieldIcon className={styles.resultIcon} />}
        {title}
      </h3>
      <p className={styles.resultSub}>{sub}</p>
      <p className={styles.quote}>&ldquo;{rec.text}&rdquo;</p>
      <dl className={styles.facts}>
        <div>
          <dt>Similar antibodies</dt>
          <dd>
            {rec.matches.length ? (
              <span className={styles.tags}>
                {rec.matches.map((m) => (
                  <span key={m.antibodyId} className={styles.tag} title={m.lessonText}>
                    {m.antibodyId} · similarity {fmtScore(m.score)}
                  </span>
                ))}
                <span className={cx(styles.muted, styles.small)}>threshold {fmtScore(rec.threshold)}</span>
              </span>
            ) : (
              <span className={styles.muted}>none at or above {fmtScore(rec.threshold)}</span>
            )}
          </dd>
        </div>
        {rec.replays.length > 0 && (
          <div>
            <dt>Replays</dt>
            <dd>
              {rec.replays.map((r) => (
                <ReplayBlock key={r.antibodyId} replay={r} view={view} text="With your rule" />
              ))}
            </dd>
          </div>
        )}
        <div>
          <dt>Cost</dt>
          <dd>
            <span className={styles.big}>{fmtMs(rec.ms)}</span> · {plural(rec.runs, "run")}
            <span className={cx(styles.muted, styles.small)}>
              {" "}
              · {rec.recognitionId} on {rec.baseVersionId}
              {rec.candidateVersionId ? ` (candidate ${rec.candidateVersionId}${rec.lessonId ? `, lesson ${rec.lessonId}` : ""})` : ""}
            </span>
          </dd>
        </div>
      </dl>
    </article>
  );
}

// ---------- antibodies ----------

function Antibodies({ view }: { view: ImmuneView }) {
  return (
    <section className={styles.section} aria-labelledby="antibodies-title">
      <h2 id="antibodies-title" className={styles.sectionTitle}>
        Antibodies
      </h2>
      <p className={styles.sectionLede}>Each one is a lesson an investigation proved harmful, with the case that proved it.</p>
      {view.antibodies.length ? (
        <div className={styles.abGrid}>
          {view.antibodies.map((ab) => (
            <AntibodyCard key={ab.antibodyId} ab={ab} />
          ))}
        </div>
      ) : (
        <p className={styles.empty}>No antibodies yet. The first verified investigation will create one.</p>
      )}
    </section>
  );
}

function AntibodyCard({ ab }: { ab: AntibodyView }) {
  const { withFails, withoutFails, trials } = ab.evidence;
  return (
    <article className={styles.abCard}>
      <header className={styles.abHead}>
        <span className={styles.abId}>
          <ShieldIcon />
          {ab.antibodyId}
        </span>
        <span className={styles.tag}>{ORIGIN_LABEL[ab.label] ?? ab.label}</span>
        <span className={cx(styles.tag, ab.repair === "removed" ? styles.tagGood : styles.tagWarn)}>
          {ab.repair === "removed" ? "removed from the agent" : "awaiting a decision"}
        </span>
      </header>
      <p className={styles.abRule}>&ldquo;{ab.lessonText}&rdquo;</p>
      <dl className={styles.facts}>
        <div>
          <dt>Evidence</dt>
          <dd>
            with the rule: <span className={styles.big}>{withFails}/{trials}</span> failed · without:{" "}
            <span className={styles.big}>{withoutFails}/{trials}</span> failed{" "}
            <span className={styles.tag}>confirmed ({trials})</span>
          </dd>
        </div>
        <div>
          <dt>Protects</dt>
          <dd>
            house rule <code className={styles.code}>{ab.targetAssertion}</code> ({humanize(ab.targetAssertion)}) on task{" "}
            <code className={styles.code}>{ab.failingTaskId}</code>, now a pinned test
          </dd>
        </div>
        <div>
          <dt>Repair</dt>
          <dd>
            {ab.repair === "removed" ? "removed" : "awaiting a decision"} (convicted lesson {ab.convictedLessonId})
          </dd>
        </div>
        <div>
          <dt>First catch</dt>
          <dd>
            <Link href={`/investigations/${ab.investigationId}`} prefetch={false}>
              investigation {ab.investigationId}
            </Link>
            {ab.firstCatch ? (
              <>
                : <span className={styles.big}>{fmtMs(ab.firstCatch.ms)}</span>, {plural(ab.firstCatch.runs, "run")},{" "}
                {plural(ab.firstCatch.modelCalls, "model call")}
              </>
            ) : (
              <span className={styles.muted}>: time not recorded</span>
            )}
          </dd>
        </div>
        <div>
          <dt>Since then</dt>
          <dd className={styles.abCounters}>
            <span>
              recognized <span className={styles.big}>{ab.recognitions}</span> {ab.recognitions === 1 ? "time" : "times"}
            </span>
            <span>
              blocked <span className={styles.big}>{ab.blocks}</span>
            </span>
          </dd>
        </div>
      </dl>
    </article>
  );
}

// ---------- recognition feed ----------

function DecisionBadge({ rec }: { rec: Recognition }) {
  if (rec.decision === "immune_blocked")
    return (
      <span className={cx(styles.badge, styles.badgeBlocked)}>
        <ShieldIcon />
        Blocked
      </span>
    );
  if (rec.decision === "immune_passed") {
    const allGood = rec.replays.every((r) => r.probe.label === "GOOD");
    return <span className={cx(styles.badge, styles.badgePassed)}>{allGood ? "Passed its case" : "Not blocked"}</span>;
  }
  return <span className={styles.badge}>No match</span>;
}

// The replay that decided: the blocking one, else the first (best match).
const decidingReplay = (rec: Recognition): Replay | undefined =>
  rec.replays.find((x) => x.antibodyId === rec.blockedBy) ?? rec.replays[0];

function feedMatch(rec: Recognition): string {
  const top = decidingReplay(rec) ?? rec.matches[0];
  if (!top) return `no antibody ≥ ${fmtScore(rec.threshold)}`;
  return `${rec.decision === "immune_blocked" ? "" : "resembled "}${top.antibodyId} · similarity ${fmtScore(top.score)}`;
}

function Feed({ view }: { view: ImmuneView }) {
  return (
    <section className={styles.section} aria-labelledby="feed-title">
      <h2 id="feed-title" className={styles.sectionTitle}>
        Recognition feed
      </h2>
      <p className={styles.sectionLede}>Every rule checked against immune memory, newest first.</p>
      {view.recognitions.length ? (
        <ol className={styles.feed}>
          {view.recognitions.map((rec) => {
            const replay = decidingReplay(rec);
            return (
              <li key={rec.recognitionId} className={styles.feedRow}>
                <span className={styles.feedTime}>{fmtClock(rec.createdAt)}</span>
                <div className={styles.feedMain}>
                  <p className={styles.feedText} title={rec.text}>
                    &ldquo;{truncate(rec.text, 110)}&rdquo;
                  </p>
                  <span className={styles.tags}>
                    <span className={styles.tag}>{ORIGIN_LABEL[rec.label] ?? rec.label}</span>
                    {rec.source === "autopilot" && <span className={styles.tag}>autopilot</span>}
                  </span>
                </div>
                <span className={styles.feedDecision}>
                  <DecisionBadge rec={rec} />
                  {replay && (
                    <span className={styles.feedSub}>
                      replay {replay.probe.counts.targetFail}/{replay.probe.trials} failed · confirmed ({replay.probe.trials})
                    </span>
                  )}
                </span>
                <span className={styles.feedMatch}>{feedMatch(rec)}</span>
                <span className={styles.feedCost}>
                  {fmtMs(rec.ms)} · {plural(rec.runs, "run")}
                </span>
              </li>
            );
          })}
        </ol>
      ) : (
        <p className={styles.empty}>No rules checked yet. Be the first: propose one above.</p>
      )}
    </section>
  );
}
