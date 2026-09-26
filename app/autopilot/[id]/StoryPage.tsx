"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import LoopStrip from "@/app/components/LoopStrip";
import StoryIcon from "@/app/components/StoryIcon";
import { formatDuration, toStory, type Story, type StoryRow } from "@/lib/story";
import type { AutopilotView } from "@/lib/types";
import styles from "./story.module.css";

// The story of one agent (UI spec §4): header, loop strip, headline numbers, one row per rule and
// moment, footer. Everything is computed from GET /api/autopilot/[id] by lib/story.ts.
export default function StoryPage({ id, openTry }: { id: string; openTry: boolean }) {
  const [view, setView] = useState<AutopilotView | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/autopilot/${id}`, { cache: "no-store" });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      setView(j as AutopilotView);
      setError(null);
      return (j as AutopilotView).session.status;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return null;
    }
  }, [id]);

  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      const status = await load();
      if (!stop && (status === "running" || status === "awaiting_decision")) timer = setTimeout(tick, 3000);
    };
    tick();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [load]);

  const story = useMemo(() => (view ? toStory(view) : null), [view]);

  if (error && !story) {
    return (
      <main className={styles.page}>
        <p className={styles.muted}>{error.includes("not found") ? `No run called ${id}.` : `Couldn't load this run: ${error}`}</p>
      </main>
    );
  }
  if (!story || !view) {
    return (
      <main className={styles.page}>
        <p className={styles.muted}>Loading…</p>
      </main>
    );
  }
  const current = story.rows.length ? story.rows[story.rows.length - 1].step : "learn";
  return (
    <main className={styles.page}>
      <Header story={story} current={current} openTry={openTry} />
      <hr className={styles.divider} />
      {story.start && <p className={styles.start}>{story.start}</p>}
      <ol className={styles.rows}>
        {story.rows.map((row) => (
          <Row key={row.key} row={row} sessionId={id} onDecided={load} />
        ))}
      </ol>
      <hr className={styles.divider} />
      <Footer story={story} id={id} />
    </main>
  );
}

function Header({ story, current, openTry }: { story: Story; current: Story["rows"][number]["step"]; openTry: boolean }) {
  const h = story.header;
  return (
    <header className={styles.header}>
      <div className={styles.titleRow}>
        <h1 className={styles.title}>
          Bisect <span className={styles.status}>{story.status === "running" ? "Running…" : story.status === "waiting" ? "Waiting for a person" : story.status === "finished" ? "Finished" : "Stopped"}</span>
        </h1>
        <Link className={styles.try} href="/immune" data-open={openTry ? "1" : undefined}>
          Try to sneak a bad rule past it
        </Link>
      </div>
      <LoopStrip current={current} />
      {h.firstCatch && (
        <div className={styles.numbers}>
          <Link className={styles.number} href={h.firstCatch.href}>
            <span className={styles.numberLabel}>First catch</span>
            <span className={styles.numberValue}>
              {formatDuration(h.firstCatch.seconds)} · {h.firstCatch.runs} runs
            </span>
          </Link>
          {h.repeatCatch && (
            <div className={styles.number}>
              <span className={styles.numberLabel}>Repeat catch</span>
              <span className={styles.numberValue}>
                {h.repeatCatch.seconds} s · {h.repeatCatch.runs} runs
              </span>
            </div>
          )}
          {h.remembered > 0 && (
            <Link className={styles.memory} href="/immune">
              Memory: {h.remembered} rule{h.remembered === 1 ? "" : "s"} remembered →
            </Link>
          )}
        </div>
      )}
    </header>
  );
}

const TONE: Record<StoryRow["kind"], string> = {
  routine: "neutral",
  accepted: "green",
  live: "neutral",
  blocked_tests: "red",
  blocked_memory: "blue",
  alarm: "red",
  bisect: "blue",
  remembered: "blue",
  needs_person: "amber",
  undecided: "neutral",
};

function Row({ row, sessionId, onDecided }: { row: StoryRow; sessionId: string; onDecided: () => void }) {
  const [open, setOpen] = useState(row.open);
  const hasMore = row.expand.length > 0 || row.links.length > 0 || (row.items?.length ?? 0) > 0 || !!row.decision;
  return (
    <li className={styles.row} data-tone={TONE[row.kind]}>
      <span className={styles.icon}>
        <StoryIcon kind={row.kind} />
      </span>
      <div className={styles.body}>
        <div className={styles.line1}>
          {hasMore ? (
            <button type="button" className={styles.toggle} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
              {row.line1}
            </button>
          ) : (
            <span>{row.line1}</span>
          )}
          {row.chip && <span className={styles.chip}>{row.chip.toUpperCase()}</span>}
        </div>
        {row.line2.map((l) => (
          <p key={l} className={styles.line2}>
            {l}
          </p>
        ))}
        {open && hasMore && (
          <div className={styles.expand}>
            {row.items && (
              <ul className={styles.items}>
                {row.items.map((it, i) => (
                  <li key={i}>
                    {it.href ? <Link href={it.href}>{cap(it.title)}</Link> : cap(it.title)}: {it.outcome}
                  </li>
                ))}
              </ul>
            )}
            {row.expand.map((l) => (
              <p key={l}>{l}</p>
            ))}
            {row.small && <p className={styles.small}>{row.small}</p>}
            {row.decision && <Decision sessionId={sessionId} onDecided={onDecided} />}
            {row.links.length > 0 && (
              <p className={styles.links}>
                {row.links.map((l) => (
                  <Link key={l.href} href={l.href}>
                    {l.label} ▸
                  </Link>
                ))}
              </p>
            )}
          </div>
        )}
      </div>
    </li>
  );
}

function Decision({ sessionId, onDecided }: { sessionId: string; onDecided: () => void }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const decide = async (decision: "approve" | "reject") => {
    setBusy(true);
    setMsg(null);
    const r = await fetch(`/api/autopilot/${sessionId}/decision`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision }),
    });
    const j = await r.json().catch(() => ({}));
    setBusy(false);
    if (!r.ok) return setMsg(j.error ?? `HTTP ${r.status}`);
    setMsg(decision === "approve" ? "Approved: the repair goes live." : "Rejected: the current version stays.");
    onDecided();
  };
  return (
    <div className={styles.decision}>
      <button type="button" disabled={busy} onClick={() => decide("approve")}>
        Approve the repair
      </button>
      <button type="button" disabled={busy} onClick={() => decide("reject")}>
        Keep things as they are
      </button>
      {msg && <p className={styles.small}>{msg}</p>}
    </div>
  );
}

function Footer({ story, id }: { story: Story; id: string }) {
  return (
    <footer className={styles.footer}>
      <p>
        {story.status === "finished"
          ? `Finished in ${formatDuration(story.footer.seconds)}.`
          : story.status === "running"
            ? `Running for ${formatDuration(story.footer.seconds)}…`
            : `Stopped after ${formatDuration(story.footer.seconds)}.`}{" "}
        <Link href={`/autopilot/${id}/details`}>Full details ▸</Link>
      </p>
      <details className={styles.about}>
        <summary>About this run</summary>
        {story.footer.plan.length > 0 && (
          <ul>
            {story.footer.plan.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        )}
        {story.footer.startLessons.length > 0 && (
          <>
            <p>The rules it started with (hand-written):</p>
            <ul>
              {story.footer.startLessons.map((l) => (
                <li key={l}>{l}</li>
              ))}
            </ul>
          </>
        )}
        <p>Tests every new rule must pass: {story.footer.gate.join("; ")}.</p>
        <p>Monitoring, after rules go live: {story.footer.monitoring.join("; ")}.</p>
      </details>
    </footer>
  );
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
