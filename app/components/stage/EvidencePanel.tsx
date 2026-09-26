"use client";

// The technical detail behind one stage step (runs, verification, re-check, similarity scores), in a
// side panel over the stage, so the evidence never takes the viewer to another page.
import Link from "next/link";
import { useEffect, useRef } from "react";
import type { EvidenceSection, StoryLink } from "@/lib/story";
import styles from "./stage.module.css";

export default function EvidencePanel({
  open,
  onClose,
  title,
  sections,
  links,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  sections: EvidenceSection[];
  links: StoryLink[];
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  return (
    <aside className={styles.panel} data-open={open ? "1" : undefined} aria-hidden={!open} aria-label="Evidence" inert={!open}>
      <div className={styles.panelHead}>
        <div>
          <p className={styles.panelKicker}>Evidence</p>
          <h2 className={styles.panelTitle}>{title}</h2>
        </div>
        <button ref={closeRef} type="button" className={styles.panelClose} onClick={onClose} aria-label="Close the evidence">
          ×
        </button>
      </div>
      {sections.map((s) => (
        <section key={s.title} className={styles.panelSection}>
          <h3>{s.title}</h3>
          <dl>
            {s.rows.map((r, n) => (
              <div key={`${r.label}-${n}`}>
                <dt>{r.label}</dt>
                <dd>{r.href ? <Link href={r.href}>{r.value}</Link> : r.value}</dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
      {links.length > 0 && (
        <p className={styles.panelLinks}>
          {links.map((l) => (
            <Link key={l.href} href={l.href}>
              {l.label} ▸
            </Link>
          ))}
        </p>
      )}
    </aside>
  );
}
