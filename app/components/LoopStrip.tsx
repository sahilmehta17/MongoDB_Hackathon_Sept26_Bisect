import { STEPS, type StoryStep } from "@/lib/story";
import styles from "./loop.module.css";

// The legend for the whole story: the same five words everywhere, the current step highlighted.
export default function LoopStrip({ current }: { current?: StoryStep | null }) {
  return (
    <ol className={styles.loop} aria-label="The loop">
      {STEPS.map((s, i) => (
        <li key={s.id} className={s.id === current ? styles.on : undefined} aria-current={s.id === current ? "step" : undefined}>
          {i > 0 && <span className={styles.arrow} aria-hidden="true">→</span>}
          {s.label}
        </li>
      ))}
    </ol>
  );
}
