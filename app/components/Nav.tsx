import Link from "next/link";
import styles from "./nav.module.css";

// The same three links on every page.
export default function Nav() {
  return (
    <nav className={styles.nav} aria-label="Main">
      <Link href="/" className={styles.brand}>
        Bisect
      </Link>
      <Link href="/story">The story</Link>
      <Link href="/autopilot">All runs</Link>
    </nav>
  );
}
