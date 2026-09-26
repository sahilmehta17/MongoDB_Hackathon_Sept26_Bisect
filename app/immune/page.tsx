import type { Metadata } from "next";
import Link from "next/link";
import ImmunePanel from "./ImmunePanel";
import styles from "./immune.module.css";

export const metadata: Metadata = {
  title: "Immune memory · Bisect",
  description: "Every proven bad lesson becomes an antibody. A reworded copy is caught by one replay, not a new investigation.",
};

// Static shell; ImmunePanel loads GET /api/immune in the browser and polls it every 5 s.
export default function ImmunePage() {
  return (
    <main className={styles.wrap}>
      <header>
        <p className={styles.eyebrow}>
          <Link href="/">Bisect</Link> · immune memory
        </p>
        <h1 className={styles.title}>Immune memory</h1>
        <p className={styles.lede}>
          When Bisect proves a lesson broke the agent, that lesson becomes an <strong>antibody</strong> in MongoDB Atlas and its
          failing case becomes a <strong>pinned test</strong>. A new rule that looks like a known bad one is replayed on that case
          with 5 fresh runs. It is blocked only if the replay fails: looking similar is never enough.
        </p>
      </header>
      <ImmunePanel />
    </main>
  );
}
