import Link from "next/link";
import styles from "./nav.module.css";

// The same links on every page: the demo, the full session log, every run, the memory.
export default function Nav() {
  return (
    <nav className={styles.nav} aria-label="Main">
      <Link href="/" className={styles.brand}>
        Bisect
      </Link>
      <Link href="/story">Session log</Link>
      <Link href="/autopilot">All runs</Link>
      <Link href="/immune">Immune memory</Link>
    </nav>
  );
}
