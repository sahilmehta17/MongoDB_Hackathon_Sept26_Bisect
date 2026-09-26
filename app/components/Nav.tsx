"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import styles from "./nav.module.css";

// The same links on every page except the demo itself, whose header stays clean.
export default function Nav() {
  if (usePathname() === "/") return null;
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
