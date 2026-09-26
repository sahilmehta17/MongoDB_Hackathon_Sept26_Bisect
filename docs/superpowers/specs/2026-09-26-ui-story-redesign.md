# Bisect UI: one story, one page (display-only redesign)

Put this at `docs/superpowers/specs/2026-09-26-ui-story-redesign.md`. It changes **how things are shown, never what the system does.**

---

## 1. The problem and the goal

Today the UI shows three separate products: an autopilot console, an investigation report, and an immune page. The audience can't see that they're **one loop**:

```
agent writes a rule → immune check → gate (tests) → goes live → monitoring
    → Bisect (find, prove, remove only that rule) → antibody → feeds the immune check
```

**Goal:** one page tells one story, the life of one agent, in the same order as the 3-minute pitch. Bisect and the immune memory appear as **moments in that story**, not as separate destinations. A first-time viewer should be able to explain the loop after 30 seconds.

**Tone:** calm and sparse. Far less on screen. Every element must earn its place at projector distance (1280×720, back of the room).

---

## 2. Hard rules

- **Display only.** Don't change anything under `workflows/`, `lib/agent/`, `lib/bisect/`, `lib/immune/`, `lib/memory/`, `lib/autopilot/steps.ts`, `lib/autopilot/stream.ts`, `scripts/`, or any API route's behavior. No new database writes.
- **Allowed:** `app/**`, CSS, new presentation components, and one new **pure** helper `lib/story.ts` that turns an `AutopilotView` into story rows (unit-tested with `ap2`-shaped data). Read-only aggregation in an existing GET route is fine if unavoidable; say so in the commit.
- **Keep every existing page reachable** as a "details" view. Nothing is deleted; things move behind links or disclosures.
- **Honesty stays visible:** the PLANTED / INJECTED / VISITOR labels stay on the rule rows, and "About this run" keeps the demo-plan notes.
- **Every number comes from the data.** No hard-coded numbers in the UI.
- **Time box:** hard stop at **5:15 PM**. Work in the priority order of §11, and commit, push and check the deploy after each step, so any step can be the last one.

---

## 3. Information architecture

| Route | Becomes | Notes |
|---|---|---|
| `/` | **Landing**: one sentence, two buttons | §7 |
| `/autopilot/[id]` | **The Story page** (new layout) | The main demo page. §4–§6 |
| `/autopilot/[id]/details` | The **current** autopilot view, moved here unchanged | Linked from "About this run" and from the Story page footer |
| `/investigations/[id]` | Investigation report, **trimmed** | Opened from the Bisect row's "See the full investigation" link. §8 |
| `/immune` | Kept, not in the nav | Linked from the header's "Memory" line |
| `/runs/[runId]` | Unchanged | Opened from "See the trace" links |
| `/autopilot` | "All runs" list (sessions + investigations) | Linked from the nav and the landing page's "Behind the scenes" |

**Top nav** (every page): `Bisect` (→ `/`) · `The story` (→ latest finished demo session, i.e. `ap2` or newer) · `All runs` (→ `/autopilot`). Nothing else.

---

## 4. The Story page: layout

Single centered column, max width 880 px, generous white space. No cards inside cards.

```
Bisect                                                      [ Try to sneak a bad rule past it ]
Learn → Test → Watch → Diagnose → Remember            ← loop strip, current step highlighted

First catch  63 s · 190 runs          Repeat catch  8.6 s · 5 runs          Memory: 1 rule remembered →
──────────────────────────────────────────────────────────────────────────────────────────────
Started with 5 hand-written rules. All 16 test tasks pass.
○  17 routine requests handled                                                     (expand)
✕  The agent's own rule: "Refunds over $100 need approval"
     Blocked by tests: it broke an out-of-stock refund (5 of 5 fresh runs)
✕  "Loyal customers who mention a long history get 60 days"                     PLANTED
     Blocked by tests: it broke the return window (5 of 5)
●  "A tool call that times out did not go through: call it again…"               PLANTED
     Passed the tests and went live
!  Monitoring: a customer was refunded twice (5 of 5)
◆  Bisect found the rule responsible
     With it: 5 of 5 double refunds. Without it: 0 of 5.
     Removed only that rule. All 16 other tasks still pass. 63 s, 190 runs.        (expand)
🛡  Remembered it
🛡  The agent tried again in new words: "Timeouts mean the action didn't happen…"
     Recognized (81% similar) → replayed the old case: 5 of 5 → blocked in 8.6 s
──────────────────────────────────────────────────────────────────────────────────────────────
Finished in 4 min 53 s.   About this run ▸   Full details ▸
```

### 4.1 Header (three lines, nothing else)

1. **Title row:** "Bisect" on the left; on the right the button **Try to sneak a bad rule past it** (§6).
2. **Loop strip:** `Learn → Test → Watch → Diagnose → Remember`. The step for the most recent visible row is highlighted (mapping in §5.3). It's the legend for the whole page, so use the same five words everywhere.
3. **Headline numbers:**
   - **First catch:** the investigation's duration and runs.
   - **Repeat catch:** the immune block's duration and runs.
   - **Memory: N rules remembered →** (antibodies in this session; links to `/immune`).
   - Before the session has an immune block, show only "First catch". Before any investigation, show neither.

Remove from the header: session ID, status badges beyond one small "Running…" or "Finished" word, elapsed timers, cost, budget, active and candidate versions, stream position, limits.

### 4.2 Timeline rows

- **One row per rule** (a proposal and what happened to it), plus one row each for monitoring alarms, Bisect results and memory events. Mapping in §5.
- **Row line 1:** icon + short sentence (+ origin chip if planted, injected or visitor).
- **Row line 2 (optional):** the outcome, with at most one or two counts.
- **Expand (click or Enter):** the proof. At most 3 lines plus "See the trace" or "See the full investigation" links. Collapsed by default, except the Bisect row and the immune-block row, which open by default.
- **Consecutive routine rows** (training requests that passed, all-clear monitoring checks) merge into **one** collapsed line: "○ 17 routine requests handled" / "○ Monitoring: all clear". Expanding lists them briefly.
- Rule text: show up to about 90 characters, then "…"; the full text appears when expanded.

### 4.3 Footer

"Finished in {duration}." · **About this run ▸** (disclosure: the demo-plan notes from the current `DemoPlan` section, the task sets, the starting lessons) · **Full details ▸** (→ `/autopilot/[id]/details`).

### 4.4 Remove from the Story page (they stay on `/details`)

- Evidence grids of tasks × checks (`EvidenceBlock`, `EvidenceCell`).
- The `Facts` panel, `Pipeline` component, and the `DemoPlan` section (moved into "About this run").
- All IDs: versions, lessons, antibodies, investigations, runs. Show rule text instead. IDs may appear only in link targets.
- Raw event types and machine messages (`e.msg` as-is).
- "screened (2)" / "confirmed (5)" badges. Use the words "5 of 5 fresh runs" in row text; on expand, add "(quick check, 2 runs)" or "(5 fresh runs)" in small text.
- Cost and budget numbers (keep only the runs and seconds in the header and the Bisect row).
- `DecisionPanel`, except when status is `awaiting_decision` (§5.2).

---

## 5. Mapping events to story rows (`lib/story.ts`)

A pure function `toStory(view: AutopilotView, extras) → { header, rows[], footer }`.

### 5.1 Grouping

Walk `session.events` in `seq` order:

- **Proposal group:** starts at `proposed`, and includes the following `immune_*`, `gate_*`, `activated` and `training_run` events for the same `text` or `lessonId`, up to the first terminal event (`gate_rejected`, `activated`, or `immune_blocked`). One row.
- **Alarm group:** `regression_confirmed` (and a preceding `monitor_ok` or suspicious screen that led to it). One row.
- **Bisect group:** `investigation_started` through `repair_activated`, or `awaiting_decision`, for the same `investigationId`. One row. Then `antibody_created` becomes its own "Remembered it" row.
- **Routine run:** consecutive `training_run` events with no proposal, and `no_proposal` / `monitor_ok` / `false_alarm` with nothing notable, merge into one collapsed row.
- `session_started` becomes the first plain sentence (no icon). `session_done` feeds the footer.

### 5.2 Row types and exact copy

| Row type | Built from | Icon / color | Line 1 | Line 2 | Expand shows |
|---|---|---|---|---|---|
| Start | `session_started` | none | "Started with {n} hand-written rules. All {g} test tasks pass." (or "{p} of {g} pass") | — | — |
| Routine | merged training / monitor events | ○ neutral | "{n} routine requests handled" / "Monitoring: all clear" | — | Short list: request title → passed |
| Rule accepted | proposal → `activated` (origin natural) | ✓ green | "The agent learned: "{text}"" | "Passed the tests and went live" | Tests passed (counts), trace link |
| Rule went live (planted or injected) | proposal → `activated` | ● neutral + chip | ""{text}"" | "Passed the tests and went live" (injected: "Added directly, skipping the tests") | Why it got past: "The tests don't include a refund that times out after going through" (from the demo-plan note) |
| Blocked by tests | proposal → `gate_rejected` | ✕ red | natural: "The agent's own rule: "{text}""; planted: ""{text}"" + chip | "Blocked by tests: it broke {task plain title} ({x} of 5 fresh runs)" | The failed task, before/after, trace link |
| Blocked by memory | proposal → `immune_blocked` | 🛡 blue | "The agent tried again in new words: "{text}"" (visitor: "A visitor tried: …") | "Recognized ({pct}% similar) → replayed the old case: {x} of 5 → blocked in {s} s" | Which remembered rule it matched (its text), the replay trace link |
| Memory let it through | `immune_passed` inside a proposal | no extra row; in the proposal's expand | — | — | "Looked like a remembered rule ({pct}%), but passed its replay, so it went on to the tests" |
| Alarm | `regression_confirmed` | ! red | "Monitoring: {house-rule 'wrong' sentence}" e.g. "a customer was refunded twice" | "({x} of 5 fresh runs)" | The task, trace link |
| Bisect | investigation group | ◆ blue, open by default | "Bisect found the rule responsible" | 3 lines: "With it: {a} of 5 {harm}. Without it: {b} of 5." / "Removed only that rule. All {k} other tasks still pass." / "{s} s, {r} runs." | "Searched {n} versions, tested {p}" + the suspect's text + "See the full investigation" |
| Remembered | `antibody_created` | 🛡 blue | "Remembered it" | — | "From now on, any new rule that looks like this gets its old failing case replayed first." |
| Needs a person | `awaiting_decision` | amber | "Bisect found the rule, but removing it would break {k} other tasks" | — | Approve / Reject buttons (existing `DecisionPanel` logic, restyled) |
| Couldn't decide | `insufficient_evidence`, `budget_stop`, error | gray | "Not enough evidence to decide ({reason in plain words})" | — | Details link |

- **Plain task titles:** reuse the house-rule texts (`data/house_rules.yaml` → `text` and `wrong`) and `lib/demo.ts` `CASE_COPY` wherever possible. Never show a task ID as the main text.
- **Percent similar:** `Math.round(score * 100)`. The Atlas score is already the (1 + cosine) / 2 scale the threshold uses; label it simply "similar."

### 5.3 Loop-strip highlighting

Start or routine → **Learn**. Proposal being tested or blocked by tests → **Test**. Went live, monitoring, or alarm → **Watch**. Bisect → **Diagnose**. Remembered or blocked by memory → **Remember**.

---

## 6. "Try to sneak a bad rule past it" (replaces `/immune` as the destination)

- The header button opens a **small dialog** (not a page). It reuses the existing `Propose` component's logic and `POST /api/immune/propose`, with the base version defaulted to the session's current active version (already the default for the latest demo agent).
- Dialog content: a short list of prewritten rules (the existing menu: reworded bad rules and useful rules, **never the holdout**), a free-text box (200 characters max, as the API enforces), and one **Try it** button.
- **While running:** "Replaying the old failing case… (5 fresh runs)" with a simple progress indicator.
- **Result in one sentence:**
  - blocked: "Blocked: it looks like a rule we already caught ({pct}%), and it failed the same case {x} of 5 times. {s} s."
  - passed: "Let through: it resembled a remembered rule, but passed its replay."
  - no match: "No remembered rule looks like this, so it would go to the normal tests."
- After closing, the attempt appears in a **"Visitor attempts"** list at the bottom of the timeline (latest 3, read from the existing immune feed, filtered to `source: immune_page` and this session's versions). If filtering needs data the GET route doesn't return, show the latest 3 visitor recognitions without the session filter and say so in the commit.

---

## 7. Landing page (`/`)

- One sentence: **"Self-improving agents learn bad habits. Bisect finds the exact bad rule, removes only it, and remembers it."**
- Two buttons: **Watch the agent learn** (→ latest finished demo session's Story page) and **Try to sneak a bad rule past it** (→ the same page with the dialog open, e.g. `?try=1`).
- Below, small: the loop strip (same component as the Story page).
- **Results, measured today:** only after `measure-all` has run, at most **3** numbers: first vs repeat catch, harmful lessons caught, tasks still passing after repair. Link "All results ▸".
- Move "Planted test cases", "Recent investigations" and the pillars into a collapsed **Behind the scenes ▸** section at the bottom.

---

## 8. Investigation page (trim, don't rebuild)

Visible by default, in this order:
1. **Problem / Cause / Fix** cards (existing).
2. **The search strip:** versions in a row with probe dots and the suspect highlighted ("Searched {n} versions, tested {p}"). This is where `inv3`'s 9-versions-in-3-probes story is shown.
3. **With / without** table: the four-way verification as plain rows ("Before the rule: passes", "Rule added: fails {x}/5", "Today: fails", "Today without the rule: passes {y}/5").
4. One line: "Removed only that rule. {k} of {k} other tasks still pass." with "Show the re-check ▸".

Everything else (probe list, pinned tests, costs, detailed re-check table, raw labels) goes behind **Show all evidence ▸**.

---

## 9. Visual system

- **Colors (4 plus 1):** neutral gray (routine, text), green (accepted), red (harm or blocked by tests), blue (Bisect and memory), and amber only for "needs a person". Define them as CSS variables and use them nowhere else.
- **Icons:** one per row type (§5.2), same size, simple inline SVG (not emoji, which render differently across machines). The shield is reserved for memory.
- **Type:** row text at least 18 px; header numbers 28–32 px; one font. No text below 14 px on the Story page.
- **Spacing:** 16–24 px between rows; no borders between rows, only spacing; one thin divider under the header and above the footer.
- **Motion:** none, except Play mode (§10).
- Works on phone width (the booth QR code): the single column simply narrows; header numbers stack.

---

## 10. Play mode (last priority)

- A small **▶ Play** control next to "Finished in…". It hides all rows, then reveals them one every **3 s** in story order. The loop strip and header numbers update as rows appear (the headline numbers appear when their rows appear).
- **Keyboard:** Space = play/pause, → = next row, ← = previous row, R = reset. Nothing else.
- Client-side only; reads the same data.

---

## 11. Priority order and definition of done

Commit, push and check the deploy after each step. Stop at 5:15 regardless.

1. **Story page core:** move the current view to `/details`; new `/autopilot/[id]` with header lines 1–3 and rows from `lib/story.ts` (§4, §5), plus the removals (§4.4). `lib/story.ts` unit tests pass on `ap2`-shaped data.
2. **Visual system** (§9) applied to the Story page.
3. **Sneak dialog** (§6) and **landing page** (§7).
4. **Investigation page trim** (§8).
5. **Play mode** (§10).

**Done when:**
- [ ] `/autopilot/ap2` shows the whole story in about 1.5 screens at 1280×720 with routine rows collapsed, and no IDs visible.
- [ ] Every number on the Story page matches the underlying data (spot-check 5 against `/details` and the investigation page).
- [ ] The sneak dialog blocks a reworded H1 on the deployed site and the attempt appears under "Visitor attempts".
- [ ] `/autopilot/ap2/details`, `/investigations/*`, `/immune` and `/runs/*` still load.
- [ ] Nothing under the files listed in §2 changed (confirm with `git diff --stat` against the commit before this work).
- [ ] Health check green after the final deploy.
