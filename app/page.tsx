"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import LoopStrip from "./components/LoopStrip";
import Results from "./Results";
import ResultsSummary from "./ResultsSummary";
import styles from "./home.module.css";

type DemoCase = {
  historyId: string;
  seedId: string;
  title: string;
  blurb: string;
  taskId: string;
  target: string;
  goodVersionId: string | null;
  versions: number;
  latest: { investigationId: string; verdict: string; acceptance: string | null } | null;
};

type Row = {
  investigationId: string;
  historyId: string;
  trigger: string;
  failureTaskId: string;
  targetAssertion: string;
  verdict: string;
  acceptance: string | null;
  suspect: { lessonId: string } | null;
  antibodyId: string | null;
  startedAt: string;
};

const VERDICT: Record<string, string> = {
  running: "running",
  verified: "found and verified",
  inconclusive: "inconclusive",
  baseline_not_reproduced: "failure didn't reproduce",
  budget_exceeded: "stopped at budget",
  error: "error",
};

const PILLARS = [
  ["Pinpoints the exact rule", "Searches the agent's version history for the one learned rule that broke things."],
  ["Verifies before blaming", "Fresh runs with and without the suspect rule, e.g. 5/5 failures with it and 0/5 without."],
  ["Removes only that rule", "Everything else the agent learned stays. A rollback would throw away every good lesson since."],
  ["Never debugs the same bug twice", "Each conviction becomes an antibody and a permanent test in MongoDB Atlas."],
];

export default function Home() {
  const router = useRouter();
  const [cases, setCases] = useState<DemoCase[] | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [hidden, setHidden] = useState<{ investigationId: string; reason: string }[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/demo", { cache: "no-store" }).then((r) => r.json()).then(setCases).catch(() => setCases([]));
    fetch("/api/investigations", { cache: "no-store" })
      .then((r) => r.json())
      .then((d: { list: Row[]; hidden: { investigationId: string; reason: string }[] }) => {
        setRows(d.list);
        setHidden(d.hidden);
      })
      .catch(() => setRows([]));
  }, []);

  async function runLive(c: DemoCase) {
    setBusy(c.historyId);
    setErr(null);
    const r = await fetch("/api/investigations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ historyId: c.historyId, taskId: c.taskId, target: c.target, ...(c.goodVersionId ? { goodVersionId: c.goodVersionId } : {}) }),
    });
    const j = await r.json();
    setBusy(null);
    if (!r.ok) return setErr(j.error ?? `request failed (${r.status})`);
    router.push(`/investigations/${j.investigationId}`);
  }

  return (
    <main className="page">
      <section className={styles.landing}>
        <h1 className={styles.sentence}>
          Self-improving agents learn bad habits. Bisect finds the exact bad rule, removes only it, and remembers it.
        </h1>
        <div className={styles.actions}>
          <Link className={styles.primary} href="/story?play=1">
            Watch the agent learn
          </Link>
          <Link className={styles.secondary} href="/story?try=1">
            Try to sneak a bad rule past it
          </Link>
        </div>
        <div className={styles.loopRow}>
          <LoopStrip />
        </div>
        <ResultsSummary onAll={() => {
          const d = document.getElementById("behind") as HTMLDetailsElement | null;
          if (d) {
            d.open = true;
            d.scrollIntoView({ behavior: "smooth" });
          }
        }} />
      </section>

      <details id="behind" className={styles.behind}>
        <summary>Behind the scenes</summary>

      <section className={styles.pillars}>
        {PILLARS.map(([h, p]) => (
          <div key={h} className={styles.pillar}>
            <h3>{h}</h3>
            <p>{p}</p>
          </div>
        ))}
      </section>

      <Results />

      <section className="section">
        <h2>Planted test cases</h2>
        <p className="section-lead">
          Each case is a history of lessons with one harmful lesson planted at a known position, so you can check that
          Bisect names the right one. Everything shown is measured live on today&apos;s build.
        </p>
        {err && <p className="notice notice-bad">{err}</p>}
        {cases === null && <p className="muted">Loading…</p>}
        {cases?.length === 0 && <p className="muted">No test cases built yet.</p>}
        <div className={styles.cases}>
          {(cases ?? []).map((c) => (
            <article key={c.historyId} className="card">
              <div className={styles.caseHead}>
                <span className="chip chip-info">planted {c.seedId}</span>
                <span className="muted">
                  history {c.historyId} · {c.versions} versions
                </span>
              </div>
              <div className="card-body">
                <h3>{c.title}</h3>
                <p>{c.blurb}</p>
                <div className={styles.caseActions}>
                  <button className="button" disabled={busy !== null} onClick={() => runLive(c)}>
                    {busy === c.historyId ? "Starting…" : "Run it live"}
                  </button>
                  {c.latest && (
                    <Link href={`/investigations/${c.latest.investigationId}`}>
                      Latest: {c.latest.investigationId} ({VERDICT[c.latest.verdict] ?? c.latest.verdict}
                      {c.latest.acceptance === "accepted" ? ", repaired" : c.latest.acceptance === "awaiting_decision" ? ", fix needs a decision" : ""})
                    </Link>
                  )}
                </div>
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className="section">
        <h2>Recent investigations</h2>
        {rows.length === 0 ? (
          <p className="muted">None yet.</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Investigation</th>
                <th>Started by</th>
                <th>Failing task</th>
                <th>Result</th>
                <th>Convicted</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.investigationId}>
                  <td>
                    <Link href={`/investigations/${r.investigationId}`}>{r.investigationId}</Link>
                  </td>
                  <td>{r.trigger === "manual" ? "a person" : r.trigger}</td>
                  <td>
                    {r.failureTaskId} <span className="muted">({r.targetAssertion})</span>
                  </td>
                  <td>
                    {VERDICT[r.verdict] ?? r.verdict}
                    {r.acceptance === "accepted" ? ", repaired" : r.acceptance === "awaiting_decision" ? ", fix needs a decision" : ""}
                  </td>
                  <td>
                    {r.suspect && r.verdict === "verified" ? r.suspect.lessonId : "—"}
                    {r.antibodyId ? ` → ${r.antibodyId}` : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {hidden.length > 0 && (
          <p className="muted">
            Not listed:{" "}
            {Object.entries(
              hidden.reduce<Record<string, string[]>>((a, h) => ((a[h.reason] = [...(a[h.reason] ?? []), h.investigationId]), a), {}),
            )
              .map(([reason, ids]) => `${ids.join(", ")} (${reason})`)
              .join("; ")}
            . Still in the database and viewable by link.
          </p>
        )}
      </section>

      </details>

      <footer className={styles.footer}>
        MongoDB Atlas holds the lessons, versions, run records and antibodies, searched with Atlas Vector Search · Vercel
        Workflows run investigations and autopilot durably · models via OpenRouter · embeddings by Voyage AI · every
        decision uses plain-code checks and fresh runs, never AI grading.
      </footer>
    </main>
  );
}
