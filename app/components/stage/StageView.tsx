"use client";

// The home page: one recorded autopilot session told in steps on one screen (Autopilot → Bisect →
// Immune memory). Everything shown comes from GET /api/autopilot/[id] through toStage (lib/story.ts);
// the last step checks a rule live with the same request as the /immune page.
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { PARTS, toStage, type StageRun, type StageStep } from "@/lib/story";
import type { AutopilotView, ImmuneView } from "@/lib/types";
import Dots from "./Dots";
import EvidencePanel from "./EvidencePanel";
import ProposeInline from "./ProposeInline";
import RuleCards, { RuleCard } from "./RuleCards";
import styles from "./stage.module.css";

const PLAY_MS = 5000;

export default function StageView({ id }: { id: string }) {
  const [view, setView] = useState<AutopilotView | null>(null);
  const [threshold, setThreshold] = useState<number | null>(null);
  const [alarmRun, setAlarmRun] = useState<StageRun | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [at, setAt] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [evidence, setEvidence] = useState(false);
  const closeEvidence = useCallback(() => setEvidence(false), []);

  // The recorded session, then the calibrated threshold and the alarm's first failing run (for the
  // concrete harm, e.g. "$80 back on a $40 order").
  useEffect(() => {
    const ctrl = new AbortController();
    (async () => {
      try {
        const r = await fetch(`/api/autopilot/${id}`, { cache: "no-store", signal: ctrl.signal });
        const v = (await r.json()) as AutopilotView & { error?: string };
        if (!r.ok) throw new Error(v.error ?? `HTTP ${r.status}`);
        const reg = v.session.events.find((e) => e.type === "regression_confirmed");
        const runId = reg?.evidence?.find((x) => x.label === "BAD")?.runIds[0];
        const [imm, run] = await Promise.all([
          fetch("/api/immune", { cache: "no-store", signal: ctrl.signal })
            .then((x) => (x.ok ? (x.json() as Promise<ImmuneView>) : null))
            .catch(() => null),
          runId
            ? fetch(`/api/runs/${encodeURIComponent(runId)}`, { signal: ctrl.signal })
                .then((x) => (x.ok ? x.json() : null))
                .catch(() => null)
            : null,
        ]);
        setThreshold(imm?.threshold ?? null);
        setAlarmRun(run ? ((run.run ?? run) as StageRun) : null);
        setView(v);
        // A step in the address (e.g. /#5) survives opening the evidence and coming back.
        const n = Number(window.location.hash.slice(1));
        if (Number.isInteger(n) && n > 0) setAt(n - 1);
      } catch (e) {
        if (!ctrl.signal.aborted) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => ctrl.abort();
  }, [id]);

  const stage = useMemo(() => (view ? toStage(view, { threshold, alarmRun }) : null), [view, threshold, alarmRun]);
  const total = stage?.steps.length ?? 0;
  const k = Math.max(0, Math.min(at, total - 1));

  const next = useCallback(() => setAt((n) => Math.min(n + 1, Math.max(total - 1, 0))), [total]);
  const back = useCallback(() => setAt((n) => Math.max(n - 1, 0)), []);
  const jump = useCallback((n: number) => {
    setPlaying(false);
    setAt(n);
  }, []);
  const togglePlay = useCallback(() => {
    if (playing) return setPlaying(false);
    setAt((n) => (n >= total - 1 ? 0 : n));
    setPlaying(true);
  }, [playing, total]);

  // Play: one step every 5 s, stopping at the live step (it never starts a check by itself).
  useEffect(() => {
    if (!playing || total === 0) return;
    const t = setInterval(() => {
      setAt((n) => {
        if (n + 1 >= total - 1) setPlaying(false);
        return Math.min(n + 1, total - 1);
      });
    }, PLAY_MS);
    return () => clearInterval(t);
  }, [playing, total]);

  // → / PageDown / Space: next · ← / PageUp: back · Home / End. Keys typed into the rule box are left alone.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (el && (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName))) return;
      const onControl = el && ["BUTTON", "A"].includes(el.tagName);
      if (e.key === "ArrowRight" || e.key === "PageDown" || (e.key === " " && !onControl)) {
        e.preventDefault();
        setPlaying(false);
        next();
      } else if (e.key === "ArrowLeft" || e.key === "PageUp") {
        e.preventDefault();
        setPlaying(false);
        back();
      } else if (e.key === "Home") {
        jump(0);
      } else if (e.key === "End") {
        jump(Math.max(total - 1, 0));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [next, back, jump, total]);

  useEffect(() => {
    if (total) window.history.replaceState(null, "", `#${k + 1}`);
  }, [k, total]);

  // Following a link to /#5 on this page (no reload) jumps to that step.
  useEffect(() => {
    const onHash = () => {
      const n = Number(window.location.hash.slice(1));
      if (Number.isInteger(n) && n > 0) {
        setPlaying(false);
        setAt(n - 1);
      }
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  if (error) {
    return (
      <main className={styles.stage}>
        <p className={styles.muted}>Couldn&apos;t load the recorded session: {error}</p>
      </main>
    );
  }
  if (!stage || !total) {
    return (
      <main className={styles.stage}>
        <p className={styles.muted}>Loading the recorded session…</p>
      </main>
    );
  }

  const step = stage.steps[k];
  const partIndex = PARTS.findIndex((p) => p.id === step.part);
  return (
    <main className={styles.stage}>
      <div className={styles.bar}>
        <p className={styles.meta}>
          Recorded session <span className={styles.mono}>{stage.sessionId}</span> · {recorded(stage.recordedAt)} · the harmful rules were planted by
          us · <Link href="/story">Full log</Link>
        </p>
        <div className={styles.controls}>
          <button type="button" onClick={() => jump(k - 1)} disabled={k === 0} aria-label="Previous step">
            ◀
          </button>
          <button type="button" onClick={togglePlay} aria-pressed={playing}>
            {playing ? "❚❚ Pause" : "⏵ Play"}
          </button>
          <button type="button" className={styles.next} onClick={() => jump(k + 1)} disabled={k === total - 1}>
            Next ▶
          </button>
          <span className={styles.count}>
            {k + 1} / {total}
          </span>
        </div>
      </div>

      <ol className={styles.parts}>
        {PARTS.map((p, n) => {
          const first = stage.steps.findIndex((s) => s.part === p.id);
          if (first < 0) return null;
          return (
            <li key={p.id} data-state={n === partIndex ? "current" : n < partIndex ? "done" : "todo"}>
              <button type="button" onClick={() => jump(first)}>
                {n + 1} · {p.label}
              </button>
            </li>
          );
        })}
      </ol>

      <section className={styles.scene} aria-live="polite">
        <h1 key={`${step.key}-h`} className={styles.headline}>
          {step.headline}
        </h1>
        {step.sub && (
          <p key={`${step.key}-s`} className={styles.sub}>
            {step.sub}
          </p>
        )}
        <div className={styles.visual}>
          <Visual step={step} baseVersionId={stage.baseVersionId} tried={stage.tried} />
        </div>
        {step.dots && (
          <div className={styles.dots}>
            {step.dots.map((d) => (
              <Dots key={d.label} {...d} />
            ))}
          </div>
        )}
        {(step.metric || step.evidence.length > 0) && (
          <p className={styles.foot}>
            {step.metric && <span className={styles.metric}>{step.metric}</span>}
            {step.evidence.length > 0 && (
              <button type="button" className={styles.evidenceButton} onClick={() => setEvidence((o) => !o)} aria-expanded={evidence}>
                {evidence ? "Hide evidence" : "Show evidence ▸"}
              </button>
            )}
          </p>
        )}
      </section>
      <EvidencePanel open={evidence && step.evidence.length > 0} onClose={closeEvidence} title={step.headline} sections={step.evidence} links={step.links} />
    </main>
  );
}

function Visual({ step, baseVersionId, tried }: { step: StageStep; baseVersionId: string; tried: string[] }) {
  if (step.live) return <ProposeInline shield={step.live.shield} baseVersionId={baseVersionId} tried={tried} />;
  if (step.compare) {
    return (
      <div className={styles.compare}>
        <RuleCard card={step.compare.old} />
        <div className={styles.between}>
          <span>{step.compare.between}</span>
          <span className={styles.arrow} aria-hidden="true">
            ⟵
          </span>
        </div>
        <RuleCard card={step.compare.new} />
      </div>
    );
  }
  return <RuleCards cards={step.cards} tone={step.tone} />;
}

function recorded(at: string): string {
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
