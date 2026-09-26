"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { Measurements } from "@/lib/types";
import styles from "./home.module.css";

const pct = (p: number, t: number) => (t ? `${Math.round((100 * p) / t)}%` : "—");
const secs = (s: number) => (s >= 90 ? `${Math.floor(s / 60)} min ${Math.round(s % 60)} s` : `${Math.round(s)} s`);

// Every number here was re-measured on today's build after the code freeze (scripts/measure-all.ts).
export default function Results() {
  const [m, setM] = useState<Measurements | null | undefined>(undefined);
  useEffect(() => {
    fetch("/api/measurements", { cache: "no-store" })
      .then((r) => r.json())
      .then(setM)
      .catch(() => setM(null));
  }, []);
  if (m === undefined) return null;
  if (m === null) {
    return (
      <section className="section">
        <h2>Results</h2>
        <p className="muted">Final numbers are measured after the code freeze and appear here.</p>
      </section>
    );
  }
  const v = m.viability;
  const im = m.immune;
  return (
    <section className="section">
      <h2>Results, measured today</h2>
      <p className="section-lead">
        Measured {new Date(m.measuredAt).toLocaleString()} on commit <code>{m.commit}</code>. Pass rates are fresh runs ({v.zeroLesson.trials} trial
        {v.zeroLesson.trials === 1 ? "" : "s"} per task); investigation checks are confirmed with 5 trials each.
      </p>
      <div className={styles.results}>
        <div className="tile">
          <div className="tile-value">
            {im.firstCatch ? secs(im.firstCatch.seconds) : "—"} → {im.repeatCatch ? secs(im.repeatCatch.seconds) : "—"}
          </div>
          <div className="tile-note">
            first catch (full investigation, {im.firstCatch?.runs ?? "—"} runs) vs repeat catch (one replay, {im.repeatCatch?.runs ?? "—"} runs)
          </div>
        </div>
        <div className="tile">
          <div className="tile-value">
            {m.investigations.filter((i) => i.correct).length} of {m.investigations.filter((i) => i.correct !== null).length}
          </div>
          <div className="tile-note">planted cases where Bisect named the planted lesson</div>
        </div>
        <div className="tile">
          <div className="tile-value">{im.holdout ? `${im.holdout.blocked} of ${im.holdout.total}` : "—"}</div>
          <div className="tile-note">
            unseen rewordings blocked (holdout; {im.holdout?.recognized ?? "—"} recognized) at threshold {im.threshold ?? "—"}
          </div>
        </div>
        <div className="tile">
          <div className="tile-value">
            {pct(v.zeroLesson.pass, v.zeroLesson.total)} → {pct(v.usefulLessons.pass, v.usefulLessons.total)}
          </div>
          <div className="tile-note">eval pass rate: no lessons vs useful lessons</div>
        </div>
      </div>
      <table className="table">
        <thead>
          <tr>
            <th>Investigation</th>
            <th>Case</th>
            <th>Named the planted lesson</th>
            <th>Result</th>
            <th>Runs</th>
            <th>Model calls</th>
            <th>Time</th>
          </tr>
        </thead>
        <tbody>
          {m.investigations.map((i) => (
            <tr key={i.investigationId}>
              <td>
                <Link href={`/investigations/${i.investigationId}`}>{i.investigationId}</Link>
              </td>
              <td>{i.seedId ?? "—"}</td>
              <td>{i.correct === null ? "—" : i.correct ? "yes" : "no"}</td>
              <td>
                {i.verdict}
                {i.acceptance ? ` (${i.acceptance === "accepted" ? "repaired" : "needs a decision"})` : ""}
              </td>
              <td>{i.runs}</td>
              <td>{i.modelCalls}</td>
              <td>{secs(i.seconds)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {m.autopilot && (
        <p>
          Autopilot <Link href={`/autopilot/${m.autopilot.sessionId}`}>{m.autopilot.sessionId}</Link>: {m.autopilot.proposals} lessons proposed,{" "}
          {m.autopilot.immuneBlocks} blocked by immune memory, {m.autopilot.gateRejections} rejected at the gate, {m.autopilot.activations} activated,{" "}
          {m.autopilot.regressionsCaught} regression{m.autopilot.regressionsCaught === 1 ? "" : "s"} caught by monitoring, {m.autopilot.repairs} repaired
          {m.autopilot.detectionToRepairSeconds !== null ? ` (${secs(m.autopilot.detectionToRepairSeconds)} from detection to repair)` : ""}.
        </p>
      )}
    </section>
  );
}
