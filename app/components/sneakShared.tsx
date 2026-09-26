// Shared by SneakDialog and VisitorAttempts: the immune endpoints, the outcome copy and the shield icon.
// Every number in the copy is read from the Recognition the server returned; nothing is estimated here.
import type { ImmuneView, Recognition } from "@/lib/types";

export const IMMUNE_URL = "/api/immune";
export const PROPOSE_URL = "/api/immune/propose";
export const MAX_CHARS = 200; // same limit as POST /api/immune/propose
export const CALIBRATING = "Immune memory is being calibrated; try again shortly.";

export type MenuItem = ImmuneView["menu"][number];
export type Replay = Recognition["replays"][number];
export type Outcome = "blocked" | "passed" | "no_match";

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");

export function outcomeOf(rec: Recognition): Outcome {
  if (rec.decision === "immune_blocked") return "blocked";
  if (rec.decision === "immune_passed") return "passed";
  return "no_match";
}

export const OUTCOME_WORD: Record<Outcome, string> = { blocked: "Blocked", passed: "Not blocked", no_match: "No match" };

// The replay that decided: the blocking one, else the first (best match).
export const decidingReplay = (rec: Recognition): Replay | undefined =>
  rec.replays.find((r) => r.antibodyId === rec.blockedBy) ?? rec.replays[0];

export const fmtSeconds = (ms: number) => (Number.isFinite(ms) && ms >= 0 ? `${(ms / 1000).toFixed(1)} s` : "? s");

export const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

// The one-sentence result, split so the outcome word can be colored. `lead` is null for "no match".
export function resultCopy(rec: Recognition): { lead: string | null; text: string } {
  const outcome = outcomeOf(rec);
  if (outcome === "blocked") {
    const r = decidingReplay(rec);
    const secs = fmtSeconds(rec.ms);
    if (!r) return { lead: "Blocked:", text: `it looks like a rule we already caught. ${secs}.` };
    const pct = Math.round(r.score * 100);
    return {
      lead: "Blocked:",
      text: `it looks like a rule we already caught (${pct}%), and it failed the same case ${r.probe.counts.targetFail} of ${r.probe.trials} times. ${secs}.`,
    };
  }
  if (outcome === "passed") {
    // Honest variants of "passed its replay": no case could be replayed (the agent already fails it),
    // or a replay was inconclusive (weak evidence never blocks).
    const next = "It would go on to the normal tests.";
    if (!rec.replays.length)
      return { lead: "Not replayed:", text: `it resembled a remembered rule, but this agent already fails that rule's case, so a replay can't tell. ${next}` };
    const many = rec.replays.length > 1;
    if (rec.replays.every((r) => r.probe.label === "GOOD"))
      return {
        lead: "Passed this replay:",
        text: many ? `it resembled remembered rules, but none of their old failures came back. ${next}` : `it resembled a remembered rule, but the old failure didn't come back. ${next}`,
      };
    return {
      lead: "Inconclusive:",
      text: many ? `it resembled remembered rules, but no replay proved it bad, so it isn't blocked. ${next}` : `it resembled a remembered rule, but its replay didn't prove it bad, so it isn't blocked. ${next}`,
    };
  }
  return { lead: null, text: "No remembered rule looks like this, so it would go to the normal tests." };
}

export const resultSentence = (rec: Recognition) => {
  const { lead, text } = resultCopy(rec);
  return lead ? `${lead} ${text}` : text;
};

// "See the trace": the first run of the deciding replay, when there is one.
export function traceHref(rec: Recognition): string | null {
  const id = decidingReplay(rec)?.probe.runIds[0];
  return id ? `/runs/${encodeURIComponent(id)}` : null;
}

// A short menu: up to 3 reworded bad rules, spread across the list (it is grouped by the rule they
// reword, so this shows one of each; rewordings already tried in the story are skipped), then the last 3 useful rules (the ones close in topic to a bad
// rule: they resemble a remembered rule, so their replay runs and lets them through).
const MENU_BAD = 3;
const MENU_USEFUL = 3;

function spread<T>(xs: T[], k: number): T[] {
  if (xs.length <= k) return xs;
  return Array.from({ length: k }, (_, i) => xs[Math.floor((i * xs.length) / k)]);
}

export function pickMenu(menu: MenuItem[], exclude: string[] = []): MenuItem[] {
  const bad = menu.filter((m) => m.kind === "reworded bad rule" && !exclude.includes(m.text));
  const useful = menu.filter((m) => m.kind === "useful rule");
  return [...spread(bad, MENU_BAD), ...useful.slice(-MENU_USEFUL)];
}

// The server's own message for a failed request (409 gets the calibration sentence).
export async function errorMessage(res: Response): Promise<string> {
  if (res.status === 409) return CALIBRATING;
  const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
  if (typeof body?.error === "string" && body.error) return body.error;
  return `the server answered ${res.status}${res.statusText ? ` ${res.statusText}` : ""}`;
}

// Memory's icon (inline SVG, same shape everywhere). Outline when memory had nothing to say.
export function ShieldIcon({ className, outline = false }: { className?: string; outline?: boolean }) {
  return (
    <svg className={className} viewBox="0 0 24 24" width="1em" height="1em" aria-hidden="true" focusable="false">
      <path
        d="M12 2.6 4.6 5.4v5.8c0 4.7 3.1 8.8 7.4 10.1 4.3-1.3 7.4-5.4 7.4-10.1V5.4L12 2.6Z"
        fill={outline ? "none" : "currentColor"}
        stroke="currentColor"
        strokeWidth={outline ? 2 : 1}
        strokeLinejoin="round"
      />
    </svg>
  );
}
