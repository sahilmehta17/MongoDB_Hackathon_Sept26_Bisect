"use client";

// The story's main visual: the agent's rule set as a row of cards. Display only: the screen passes the
// cards for each step, and a card's stable `key` lets a state change animate with CSS transitions.
import { useId, type JSX } from "react";
import { ShieldIcon, cx } from "@/app/components/sneakShared";
import styles from "./cards.module.css";

export type CardState =
  | "live" // normal card in the agent's rule set
  | "dim" // de-emphasised (other cards while one is in focus)
  | "new" // just arrived: animate in, subtle blue outline
  | "rejected" // tests rejected it: red ✕ badge, dimmed, dropped slightly
  | "suspect" // Bisect's focus: thick blue ring, slightly larger
  | "removed" // lifted out: faded, dashed outline
  | "shield" // remembered: blue shield treatment with the word "Remembered"
  | "incoming" // a new wording approaching the shield: tilted, blue dashed outline
  | "blocked" // the incoming card after the check: red ✕ badge + one short shake
  | "passed"; // the incoming card after the check: green ✓ badge

export interface RuleCardData {
  key: string; // stable across steps, so state changes animate with CSS transitions
  text: string; // full rule text; clamped visually to 4 lines, full text in the title attribute
  tag?: string; // tiny label at the top of the card, e.g. "L52" or "seed"
  origin?: "seeded" | "natural" | "planted" | "injected" | "visitor"; // chip only for planted / injected / visitor
  state: CardState;
  note?: string; // one short line under the card
}

// The card the story is about at that moment is drawn wider (~200px instead of ~160px).
const WIDE: ReadonlySet<CardState> = new Set<CardState>(["suspect", "shield", "incoming", "blocked", "passed"]);

// Honesty labels: only rules that did not come from the seed or the agent's own learning get a chip.
const ORIGIN_CHIP: Partial<Record<NonNullable<RuleCardData["origin"]>, string>> = {
  planted: "Planted",
  injected: "Injected",
  visitor: "Visitor",
};

const BADGE: Partial<Record<CardState, "bad" | "good">> = { rejected: "bad", blocked: "bad", passed: "good" };

// The state in words for screen readers (the badge and the outlines are only drawn; "Remembered" is visible text).
const STATE_WORDS: Partial<Record<CardState, string>> = {
  new: "New rule.",
  rejected: "Rejected by the tests.",
  suspect: "Bisect's suspect.",
  removed: "Removed.",
  incoming: "New wording.",
  blocked: "Blocked.",
  passed: "Passed.",
};

// ✕ / ✓ drawn as strokes so they sit in the middle of the circle whatever the system font is.
function Mark({ good }: { good: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="1em"
      height="1em"
      aria-hidden="true"
      focusable="false"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.6}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={good ? "M3.4 8.5 6.6 11.6 12.6 4.8" : "M4.6 4.6l6.8 6.8M11.4 4.6l-6.8 6.8"} />
    </svg>
  );
}

export function RuleCard({ card }: { card: RuleCardData }): JSX.Element {
  const { text, tag, origin, state, note } = card;
  const chip = origin ? ORIGIN_CHIP[origin] : undefined;
  const badge = BADGE[state];
  const words = STATE_WORDS[state];
  const shield = state === "shield";

  return (
    <div className={cx(styles.rc, styles[state], WIDE.has(state) && styles.rcWide)} data-state={state}>
      <div className={styles.frame}>
        <div className={styles.card} title={text}>
          {words && <span className="sr-only">{words}</span>}
          {(tag || chip || shield) && (
            <div className={styles.top}>
              {shield && (
                <span className={styles.remembered}>
                  <ShieldIcon className={styles.shieldIcon} />
                  Remembered
                </span>
              )}
              {tag && <span className={styles.tag}>{tag}</span>}
              {chip && origin && <span className={cx(styles.origin, styles[origin])}>{chip}</span>}
            </div>
          )}
          <p className={styles.text}>{text}</p>
        </div>
        {badge && (
          <span key={state} className={cx(styles.badge, badge === "good" ? styles.badgeGood : styles.badgeBad)} aria-hidden="true">
            <Mark good={badge === "good"} />
          </span>
        )}
      </div>
      {note && <p className={styles.note}>{note}</p>}
    </div>
  );
}

export function RuleCards({
  cards,
  tone = "normal",
  label,
}: {
  cards: RuleCardData[];
  tone?: "normal" | "alarm";
  label?: string;
}): JSX.Element {
  const labelId = useId();
  return (
    <div className={cx(styles.cards, tone === "alarm" && styles.alarm)}>
      {label && (
        <p id={labelId} className={styles.caption}>
          {label}
        </p>
      )}
      <ul className={styles.row} aria-labelledby={label ? labelId : undefined}>
        {cards.map((card) => (
          <li key={card.key} className={cx(styles.item, WIDE.has(card.state) && styles.itemWide)}>
            <RuleCard card={card} />
          </li>
        ))}
      </ul>
    </div>
  );
}

export default RuleCards;
