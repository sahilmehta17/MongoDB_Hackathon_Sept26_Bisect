// One line of repeated runs: a label, then one dot per run (failed = filled red, passed = hollow green
// ring), then an optional note. Display only; the counts come from the caller.
import type { JSX } from "react";
import { cx } from "@/app/components/sneakShared";
import styles from "./cards.module.css";

const count = (n: number) => Math.max(0, Math.floor(n) || 0);

export function Dots({ label, fail, total, note }: { label: string; fail: number; total: number; note?: string }): JSX.Element {
  const runs = count(total);
  const failed = Math.min(runs, count(fail));
  return (
    <div className={styles.dots}>
      <span className={styles.dotsLabel}>{label}</span>
      <span className={styles.dotRow} role="img" aria-label={`${failed} of ${runs} ${runs === 1 ? "run" : "runs"} failed`}>
        {Array.from({ length: runs }, (_, i) => (
          <span key={i} className={cx(styles.dot, i < failed && styles.dotFail)} />
        ))}
      </span>
      {note && <span className={styles.dotsNote}>{note}</span>}
    </div>
  );
}

export default Dots;
