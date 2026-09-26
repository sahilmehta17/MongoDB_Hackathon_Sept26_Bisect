"use client";

// "Visitor attempts": the latest 3 rules visitors tried from the sneak dialog on this agent, read from
// the immune feed (GET /api/immune, newest first) and filtered to source "immune_page" and this base version.
import { useEffect, useId, useState } from "react";
import type { ImmuneView, Recognition } from "@/lib/types";
import styles from "./sneak.module.css";
import { IMMUNE_URL, OUTCOME_WORD, ShieldIcon, cx, fmtSeconds, outcomeOf, truncate } from "./sneakShared";

export type VisitorAttemptsProps = {
  baseVersionId: string;
  refreshKey?: number; // change it (e.g. after the dialog's onResult) to refetch
};

const SHOWN = 3;
const TEXT_CHARS = 70;

export function VisitorAttempts({ baseVersionId, refreshKey = 0 }: VisitorAttemptsProps) {
  const [feed, setFeed] = useState<Recognition[] | null>(null);
  const [failed, setFailed] = useState(false);
  const headingId = useId();

  useEffect(() => {
    const ctrl = new AbortController();
    fetch(IMMUNE_URL, { cache: "no-store", signal: ctrl.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`the server answered ${res.status}`);
        return (await res.json()) as ImmuneView;
      })
      .then((view) => {
        setFeed(view.recognitions ?? []);
        setFailed(false);
      })
      .catch(() => {
        if (!ctrl.signal.aborted) setFailed(true);
      });
    return () => ctrl.abort();
  }, [refreshKey]);

  const attempts = (feed ?? []).filter((r) => r.source === "immune_page" && r.baseVersionId === baseVersionId).slice(0, SHOWN);

  return (
    <section className={styles.attempts} aria-labelledby={headingId}>
      <h2 id={headingId} className={styles.attemptsTitle}>
        Visitor attempts
      </h2>
      {attempts.length > 0 ? (
        <ul className={styles.attemptList}>
          {attempts.map((rec) => {
            const outcome = outcomeOf(rec);
            return (
              <li key={rec.recognitionId} className={styles.attempt}>
                <ShieldIcon className={styles.attemptIcon} outline={outcome === "no_match"} />
                <span className={styles.attemptText} title={rec.text}>
                  &ldquo;{truncate(rec.text, TEXT_CHARS)}&rdquo;
                </span>{" "}
                <span className={styles.attemptMeta}>
                  <span className={cx(styles.word, outcome === "blocked" ? styles.blocked : outcome === "passed" ? styles.passed : styles.noMatch)}>
                    {OUTCOME_WORD[outcome]}
                  </span>{" "}
                  <span className={styles.secs}>{fmtSeconds(rec.ms)}</span>
                </span>
              </li>
            );
          })}
        </ul>
      ) : feed ? (
        <p className={styles.empty}>No visitor attempts yet.</p>
      ) : failed ? (
        <p className={styles.empty}>Couldn&apos;t load visitor attempts.</p>
      ) : null}
    </section>
  );
}

export default VisitorAttempts;
