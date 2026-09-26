"use client";

// "Try to sneak a bad rule past it": a small modal over the Story page. Same request as the Propose
// form on /immune (POST /api/immune/propose with { text, baseVersionId }); the server labels the rule
// "visitor". The prewritten rules come from GET /api/immune (the calibration menu, never the holdout).
import Link from "next/link";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { LIMITS, type ImmuneView, type Recognition } from "@/lib/types";
import styles from "./sneak.module.css";
import {
  CALIBRATING,
  IMMUNE_URL,
  MAX_CHARS,
  PROPOSE_URL,
  ShieldIcon,
  cx,
  errorMessage,
  outcomeOf,
  pickMenu,
  resultCopy,
  traceHref,
  type MenuItem,
} from "./sneakShared";

export type SneakDialogProps = {
  open: boolean;
  onClose: () => void;
  baseVersionId: string;
  onResult?: (rec: Recognition) => void;
};

type Status =
  | { kind: "idle" }
  | { kind: "running"; startedAt: number }
  | { kind: "done"; rec: Recognition }
  | { kind: "error"; message: string };

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function SneakDialog({ open, onClose, baseVersionId, onResult }: SneakDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const statusRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const pressedOnBackdrop = useRef(false);
  const ids = useId();

  const [menu, setMenu] = useState<MenuItem[] | null>(null);
  const [menuFailed, setMenuFailed] = useState(false);
  const [calibrated, setCalibrated] = useState<boolean | null>(null); // null: not known yet
  const [draft, setDraft] = useState("");
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [now, setNow] = useState(0);

  // Follow the `open` prop with the native modal (Escape, focus containment and the backdrop come free).
  useEffect(() => {
    const d = dialogRef.current;
    if (!d) return;
    if (open && !d.open) {
      openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      d.showModal();
      titleRef.current?.focus();
    } else if (!open && d.open) {
      d.close();
    }
  }, [open]);

  // The prewritten rules and the calibration state, fresh each time the dialog opens.
  useEffect(() => {
    if (!open) return;
    const ctrl = new AbortController();
    fetch(IMMUNE_URL, { cache: "no-store", signal: ctrl.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(await errorMessage(res));
        return (await res.json()) as ImmuneView;
      })
      .then((view) => {
        setMenu(pickMenu(view.menu ?? []));
        setCalibrated(view.threshold !== null);
        setMenuFailed(false);
      })
      .catch(() => {
        if (!ctrl.signal.aborted) setMenuFailed(true);
      });
    return () => ctrl.abort();
  }, [open]);

  const running = status.kind === "running";

  // Elapsed seconds while the replay runs (the call takes about 5 to 15 s).
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(id);
  }, [running]);

  // Keep the progress line and the result in view on short screens.
  useEffect(() => {
    if (status.kind !== "idle") statusRef.current?.scrollIntoView({ block: "nearest" });
  }, [status.kind]);

  const text = draft.replace(/\s+/g, " ").trim();
  const canSubmit = !running && !!text && text.length <= MAX_CHARS && !!baseVersionId && calibrated !== false;

  function choose(value: string) {
    setDraft(value);
    if (!running) setStatus({ kind: "idle" }); // a result belongs to the rule that was tried
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    const startedAt = Date.now();
    setNow(startedAt);
    setStatus({ kind: "running", startedAt });
    try {
      const res = await fetch(PROPOSE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, baseVersionId }),
      });
      if (!res.ok) {
        setStatus({ kind: "error", message: await errorMessage(res) });
        return;
      }
      const rec = (await res.json()) as Recognition;
      setStatus({ kind: "done", rec });
      onResult?.(rec);
    } catch (err) {
      setStatus({ kind: "error", message: `network error (${errorText(err)})` });
    }
  }

  function handleClose() {
    if (!running) setStatus({ kind: "idle" }); // an attempt still running keeps going and reports back
    onClose();
    const opener = openerRef.current;
    if (opener?.isConnected) opener.focus();
  }

  const elapsed = status.kind === "running" ? Math.max(0, now - status.startedAt) : 0;
  const titleId = `${ids}-title`;
  const menuLabelId = `${ids}-menu`;
  const textId = `${ids}-text`;
  const hintId = `${ids}-hint`;

  return (
    <dialog
      ref={dialogRef}
      className={styles.dialog}
      aria-labelledby={titleId}
      onClose={handleClose}
      // A press that starts and ends on the backdrop (the dialog box itself, outside .inner) closes it.
      onMouseDown={(e) => {
        pressedOnBackdrop.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        if (pressedOnBackdrop.current && e.target === e.currentTarget) dialogRef.current?.close();
        pressedOnBackdrop.current = false;
      }}
    >
      <div className={styles.inner}>
        <div className={styles.head}>
          <h2 id={titleId} ref={titleRef} className={styles.title} tabIndex={-1}>
            Try to sneak a bad rule past it
          </h2>
          <button type="button" className={styles.close} aria-label="Close" onClick={() => dialogRef.current?.close()}>
            <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false">
              <path d="M6 6l12 12M18 6 6 18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </button>
        </div>
        <p className={styles.lede}>
          If it looks like a rule Bisect already caught, that rule&apos;s old failing case is replayed with yours. It is blocked only
          if the replay fails.
        </p>

        <form onSubmit={submit} className={styles.form}>
          <fieldset className={styles.fieldset} disabled={running}>
            <div className={styles.pick}>
              {menu && menu.length > 0 ? (
                <>
                  <p className={styles.label} id={menuLabelId}>
                    Pick one
                  </p>
                  <ul className={styles.menu} aria-labelledby={menuLabelId}>
                    {menu.map((m) => (
                      <li key={m.text}>
                        <button type="button" className={styles.menuItem} aria-pressed={draft === m.text} onClick={() => choose(m.text)}>
                          <span className={cx(styles.tag, m.kind === "reworded bad rule" ? styles.tagBad : styles.tagGood)}>{m.kind}</span>{" "}
                          {m.text}
                        </button>
                      </li>
                    ))}
                  </ul>
                </>
              ) : (
                <p className={styles.note}>
                  {menuFailed ? "Couldn't load the prewritten rules; you can still write your own." : menu ? "No prewritten rules yet." : "Loading prewritten rules…"}
                </p>
              )}
            </div>

            <div className={styles.write}>
              <div>
                <label className={styles.label} htmlFor={textId}>
                  {menu && menu.length > 0 ? "…or write your own" : "Your rule"}
                </label>
                <textarea
                  id={textId}
                  className={styles.textarea}
                  value={draft}
                  maxLength={MAX_CHARS}
                  rows={3}
                  aria-describedby={hintId}
                  placeholder="A rule for the support agent, e.g. about refunds, timeouts or addresses."
                  onChange={(e) => choose(e.target.value)}
                  onKeyDown={(e) => {
                    // Cmd/Ctrl+Enter submits; plain Enter stays a newline (the server folds it into a space).
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                      e.preventDefault();
                      e.currentTarget.form?.requestSubmit();
                    }
                  }}
                />
                <p className={styles.hint} id={hintId}>
                  <span>
                    Your rule is labelled <strong>visitor</strong>.
                  </span>
                  <span className={styles.counter}>
                    {draft.length}/{MAX_CHARS}
                  </span>
                </p>
              </div>

              {calibrated === false && <p className={styles.note}>{CALIBRATING}</p>}

              <div>
                <button type="submit" className={styles.button} disabled={!canSubmit}>
                  {running ? "Trying…" : "Try it"}
                </button>
              </div>

              <div ref={statusRef}>
                <div aria-live="polite">
                  {status.kind === "running" && (
                    <p className={styles.running}>Replaying the old failing case… ({LIMITS.confirmTrials} fresh runs)</p>
                  )}
                  {status.kind === "done" && <Result rec={status.rec} />}
                  {status.kind === "error" &&
                    (status.message === CALIBRATING ? (
                      <p className={styles.note}>{CALIBRATING}</p>
                    ) : (
                      <p className={styles.error}>
                        <strong>Couldn&apos;t check this rule:</strong> {status.message}
                      </p>
                    ))}
                </div>
                {status.kind === "running" && (
                  <div className={styles.progressRow}>
                    <div className={styles.bar} role="progressbar" aria-label="Checking your rule" />
                    <span className={styles.timer}>{(elapsed / 1000).toFixed(1)} s</span>
                  </div>
                )}
              </div>
            </div>
          </fieldset>
        </form>
      </div>
    </dialog>
  );
}

function Result({ rec }: { rec: Recognition }) {
  const outcome = outcomeOf(rec);
  const { lead, text } = resultCopy(rec);
  const href = traceHref(rec);
  return (
    <div className={styles.result}>
      <ShieldIcon className={cx(styles.resultIcon, outcome === "no_match" && styles.noMatch)} outline={outcome === "no_match"} />
      <div>
        <p className={styles.resultText}>
          {lead && (
            <>
              <strong className={outcome === "blocked" ? styles.blocked : styles.passed}>{lead}</strong>{" "}
            </>
          )}
          {text}
        </p>
        {href && (
          <Link href={href} prefetch={false} className={styles.trace}>
            See the trace
          </Link>
        )}
      </div>
    </div>
  );
}

export default SneakDialog;
