"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

type Row = {
  investigationId: string;
  trigger: string;
  failureTaskId: string;
  targetAssertion: string;
  verdict: string;
  acceptance: string | null;
};

const VERDICT: Record<string, string> = {
  running: "running",
  verified: "found and proven",
  inconclusive: "inconclusive",
  baseline_not_reproduced: "failure didn't reproduce",
  budget_exceeded: "stopped at budget",
  error: "error",
};

// Every investigation, newest first (hidden ones are counted with their reason).
export default function InvestigationsList() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [hidden, setHidden] = useState<{ investigationId: string; reason: string }[]>([]);
  useEffect(() => {
    fetch("/api/investigations", { cache: "no-store" })
      .then((r) => r.json())
      .then((d: { list: Row[]; hidden: { investigationId: string; reason: string }[] }) => {
        setRows(d.list);
        setHidden(d.hidden);
      })
      .catch(() => setRows([]));
  }, []);
  return (
    <section className="report section" aria-labelledby="investigations-h">
      <h2 id="investigations-h">Investigations</h2>
      {rows === null ? (
        <p className="muted">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="muted">None yet.</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Investigation</th>
              <th>Started by</th>
              <th>Failing task</th>
              <th>Result</th>
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
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {hidden.length > 0 && (
        <p className="muted">
          Not listed: {hidden.map((h) => h.investigationId).join(", ")} ({hidden[0].reason}). Still viewable by link.
        </p>
      )}
    </section>
  );
}
