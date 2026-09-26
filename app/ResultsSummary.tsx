"use client";

import { useEffect, useState } from "react";
import { shortDuration } from "@/lib/story";
import type { Measurements } from "@/lib/types";
import styles from "./home.module.css";

// At most three measured numbers on the landing page, only after scripts/measure-all.ts has run.
export default function ResultsSummary({ onAll }: { onAll: () => void }) {
  const [m, setM] = useState<Measurements | null>(null);
  useEffect(() => {
    fetch("/api/measurements", { cache: "no-store" })
      .then((r) => r.json())
      .then(setM)
      .catch(() => setM(null));
  }, []);
  if (!m) return null;
  const planted = m.investigations.filter((i) => i.correct !== null);
  const caught = planted.filter((i) => i.correct && i.verdict === "verified").length;
  const undo = m.viability.afterUndo.reduce((a, r) => ({ pass: a.pass + r.pass, total: a.total + r.total }), { pass: 0, total: 0 });
  const f = m.immune.firstCatch;
  const r = m.immune.repeatCatch;
  return (
    <div className={styles.summary}>
      <p className={styles.summaryTitle}>Results, measured today</p>
      <div className={styles.summaryNumbers}>
        {f && r && (
          <div>
            <strong>
              {shortDuration(f.seconds)} → {shortDuration(r.seconds)}
            </strong>
            <span>
              first catch ({f.runs} runs) vs repeat catch ({r.runs} runs)
            </span>
          </div>
        )}
        {planted.length > 0 && (
          <div>
            <strong>
              {caught} of {planted.length}
            </strong>
            <span>planted harmful rules found and proven</span>
          </div>
        )}
        {undo.total > 0 && (
          <div>
            <strong>{Math.round((100 * undo.pass) / undo.total)}%</strong>
            <span>of tasks still pass after the repair</span>
          </div>
        )}
      </div>
      <button type="button" className={styles.allResults} onClick={onAll}>
        All results ▸
      </button>
    </div>
  );
}
