"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import LoopStrip from "@/app/components/LoopStrip";
import StoryIcon from "@/app/components/StoryIcon";
import { formatDuration, shortDuration, toStory, type Story, type StoryRow } from "@/lib/story";
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
  const play = usePlay(story?.rows.length ?? 0);

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
  // In Play mode only the rows revealed so far count, including for the header.
  const rows = play.shown === null ? story.rows : story.rows.slice(0, play.shown);
  const shownStory: Story = { ...story, rows, header: headerFor(rows) };
  const current = rows.length ? rows[rows.length - 1].step : "learn";
  return (
    <main className={styles.page}>
      <Header story={shownStory} current={current} openTry={openTry} />
      <hr className={styles.divider} />
      {story.start && <p className={styles.start}>{story.start}</p>}
      <ol className={styles.rows}>
        {rows.map((row) => (
          <Row key={row.key} row={row} sessionId={id} onDecided={load} />
        ))}
      </ol>
      <hr className={styles.divider} />
      <Footer story={story} id={id} play={play} />
    </main>
  );
}

// The header numbers for the rows on screen: the first catch appears with the Bisect row, the
// repeat catch with the immune block, the memory count with each "remembered" row.
function headerFor(rows: StoryRow[]): Story["header"] {
  const bisect = rows.find((r) => r.kind === "bisect" && r.numbers);
  const block = rows.find((r) => r.kind === "blocked_memory" && r.numbers);
  const href = bisect?.links.find((l) => l.href.startsWith("/investigations/"))?.href ?? "/immune";
  return {
    firstCatch: bisect?.numbers ? { ...bisect.numbers, href } : null,
    repeatCatch: bisect && block?.numbers ? block.numbers : null,
    remembered: rows.filter((r) => r.kind === "remembered").length,
  };
}

// Play mode (UI spec §10): reveal one row every 3 s. Space plays or pauses, → next, ← previous,
// R resets to the start. null means every row is shown (not playing).
type Play = { shown: number | null; playing: boolean; toggle: () => void };
function usePlay(total: number): Play {
  const [shown, setShown] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  useEffect(() => {
    if (!playing) return;
    const t = setInterval(() => {
      setShown((n) => {
        const next = (n ?? 0) + 1;
        if (next >= total) setPlaying(false);
        return Math.min(next, total);
      });
    }, 3000);
    return () => clearInterval(t);
  }, [playing, total]);
  const toggle = useCallback(() => {
    if (playing) return setPlaying(false);
    setShown((n) => (n === null || n >= total ? 0 : n));
    setPlaying(true);
  }, [playing, total]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT", "BUTTON", "A"].includes(el.tagName)) && e.key === " ") return;
      if (el && ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName)) return;
      if (document.querySelector("dialog[open]")) return;
      if (e.key === " ") {
        e.preventDefault();
        toggle();
      } else if (e.key === "ArrowRight") {
        setPlaying(false);
        setShown((n) => Math.min((n ?? total) >= total ? total : (n ?? 0) + 1, total));
      } else if (e.key === "ArrowLeft") {
        setPlaying(false);
        setShown((n) => Math.max((n ?? total) - 1, 0));
      } else if (e.key === "r" || e.key === "R") {
        setPlaying(false);
        setShown(0);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggle, total]);
  return { shown, playing, toggle };
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
              {shortDuration(h.firstCatch.seconds)} · {h.firstCatch.runs} runs
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
            {row.decision && <Decision sessionId={sessionId} onDecided={onDecided} />}
            {(row.small || row.links.length > 0) && (
              <p className={styles.links}>
                {row.small && <span className={styles.small}>{row.small}</span>}
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

function Footer({ story, id, play }: { story: Story; id: string; play: Play }) {
  return (
    <footer className={styles.footer}>
      <p>
        <button type="button" className={styles.play} onClick={play.toggle} aria-pressed={play.playing}>
          {play.playing ? "❚❚ Pause" : "▶ Play"}
        </button>{" "}
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
