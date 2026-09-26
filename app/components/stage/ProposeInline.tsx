"use client";

// The stage's last step: propose a rule and let immune memory check it live. Same request as the
// /immune page and the sneak dialog (POST /api/immune/propose); the server labels the rule "visitor".
import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import { shorten, type StageCard } from "@/lib/story";
import { LIMITS, type ImmuneView, type Recognition } from "@/lib/types";
import {
  CALIBRATING,
  IMMUNE_URL,
  MAX_CHARS,
  PROPOSE_URL,
  decidingReplay,
  errorMessage,
  fmtSeconds,
  outcomeOf,
  pickMenu,
  resultCopy,
  traceHref,
  type MenuItem,
} from "@/app/components/sneakShared";
import Dots from "./Dots";
import { RuleCard } from "./RuleCards";
import styles from "./stage.module.css";

type Status = { kind: "idle" } | { kind: "running"; startedAt: number } | { kind: "done"; rec: Recognition } | { kind: "error"; message: string };

export default function ProposeInline({ shield, baseVersionId, tried }: { shield: StageCard; baseVersionId: string; tried: string[] }) {
  const [menu, setMenu] = useState<MenuItem[] | null>(null);
  const [calibrated, setCalibrated] = useState<boolean | null>(null);
  const [draft, setDraft] = useState("");
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [now, setNow] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const triedKey = tried.join("\n");

  // Prewritten rules (never the holdout); the first reworded bad rule the story hasn't shown starts selected.
  useEffect(() => {
    const ctrl = new AbortController();
    fetch(IMMUNE_URL, { cache: "no-store", signal: ctrl.signal })
      .then((r) => (r.ok ? (r.json() as Promise<ImmuneView>) : Promise.reject(new Error(String(r.status)))))
      .then((v) => {
        const picked = pickMenu(v.menu ?? [], triedKey ? triedKey.split("\n") : []);
        setMenu(picked);
        setCalibrated(v.threshold !== null);
        setDraft((d) => d || (picked.find((m) => m.kind === "reworded bad rule")?.text ?? ""));
      })
      .catch(() => {
        if (!ctrl.signal.aborted) setMenu([]);
      });
    return () => ctrl.abort();
  }, [triedKey]);

  const running = status.kind === "running";
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(t);
  }, [running]);

  const text = draft.replace(/\s+/g, " ").trim();
  const canSubmit = !running && !!text && text.length <= MAX_CHARS && !!baseVersionId && calibrated !== false;

  function choose(value: string) {
    setDraft(value);
    if (!running) setStatus({ kind: "idle" });
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    const startedAt = Date.now();
    setNow(startedAt);
    setAttempt((a) => a + 1);
    setStatus({ kind: "running", startedAt });
    try {
      const res = await fetch(PROPOSE_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, baseVersionId }) });
      if (!res.ok) return setStatus({ kind: "error", message: await errorMessage(res) });
      setStatus({ kind: "done", rec: (await res.json()) as Recognition });
    } catch (err) {
      setStatus({ kind: "error", message: `network error (${err instanceof Error ? err.message : String(err)})` });
    }
  }

  const rec = status.kind === "done" ? status.rec : null;
  const outcome = rec ? outcomeOf(rec) : null;
  const replay = rec ? decidingReplay(rec) : undefined;
  const allGood = !!rec && rec.replays.length > 0 && rec.replays.every((r) => r.probe.label === "GOOD");
  const draftCard: StageCard = {
    key: `draft-${attempt}`,
    text: text || "Your rule",
    tag: "visitor",
    origin: "visitor",
    state: outcome === "blocked" ? "blocked" : outcome === "passed" && allGood ? "passed" : "incoming",
    note: outcome === "blocked" ? "blocked" : outcome === "passed" ? (allGood ? "passed this replay" : "not blocked") : outcome === "no_match" ? "no match" : undefined,
  };
  const between = running
    ? `replaying… ${((now - (status.kind === "running" ? status.startedAt : now)) / 1000).toFixed(1)} s`
    : replay
      ? `${Math.round(replay.score * 100)}% similar`
      : outcome === "no_match"
        ? "not similar"
        : "compare";
  const copy = rec ? resultCopy(rec) : null;
  const href = rec ? traceHref(rec) : null;
  const bad = menu?.filter((m) => m.kind === "reworded bad rule") ?? [];
  const good = menu?.filter((m) => m.kind === "useful rule") ?? [];

  return (
    <div className={styles.live}>
      <div className={styles.compare}>
        <RuleCard card={shield} />
        <div className={styles.between}>
          <span>{between}</span>
          <span className={styles.arrow} aria-hidden="true">
            ⟵
          </span>
        </div>
        <RuleCard key={draftCard.key} card={draftCard} />
      </div>

      <form className={styles.form} onSubmit={submit}>
        <div className={styles.inputRow}>
          <textarea
            className={styles.textarea}
            value={draft}
            maxLength={MAX_CHARS}
            rows={2}
            aria-label="A rule for the support agent"
            placeholder="A rule for the support agent, e.g. about refunds, timeouts or addresses."
            disabled={running}
            onChange={(e) => choose(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                e.currentTarget.form?.requestSubmit();
              }
            }}
          />
          <button type="submit" className={styles.check} disabled={!canSubmit}>
            {running ? "Checking…" : "Check it"}
          </button>
        </div>
        {(bad.length > 0 || good.length > 0) && (
          <div className={styles.examples}>
            <ExampleList title="Reworded bad rules" items={bad} draft={draft} disabled={running} onPick={choose} />
            <ExampleList title="Useful rules" items={good} draft={draft} disabled={running} onPick={choose} />
          </div>
        )}
      </form>

      <div aria-live="polite" className={styles.outcome}>
        {calibrated === false && <p className={styles.muted}>{CALIBRATING}</p>}
        {running && <p className={styles.muted}>Replaying the old failing request with this rule ({LIMITS.confirmTrials} fresh runs)…</p>}
        {status.kind === "error" && <p className={styles.error}>Couldn&apos;t check this rule: {status.message}</p>}
        {rec && copy && (
          <>
            <p className={styles.resultLine}>
              {copy.lead && <strong data-outcome={outcome === "blocked" ? "bad" : "good"}>{copy.lead}</strong>} {copy.text}{" "}
              <span className={styles.mono}>{fmtSeconds(rec.ms)}</span>
              {href && (
                <>
                  {" "}
                  <Link href={href}>See the trace ▸</Link>
                </>
              )}
            </p>
            {replay && <Dots label="Replay" fail={replay.probe.counts.targetFail} total={replay.probe.trials} note={replay.probe.counts.targetFail ? "the old failure came back" : "the old failure didn't come back"} />}
          </>
        )}
      </div>
    </div>
  );
}

function ExampleList({ title, items, draft, disabled, onPick }: { title: string; items: MenuItem[]; draft: string; disabled: boolean; onPick: (t: string) => void }) {
  if (!items.length) return null;
  return (
    <div>
      <p className={styles.exampleTitle}>{title}</p>
      <ul className={styles.exampleList}>
        {items.map((m) => (
          <li key={m.text}>
            <button type="button" aria-pressed={draft === m.text} disabled={disabled} onClick={() => onPick(m.text)} title={m.text}>
              {shorten(m.text, 64)}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
