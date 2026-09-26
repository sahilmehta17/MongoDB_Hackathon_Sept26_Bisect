# Bisect: fresh build with immune memory and autopilot (final spec, Sat Sep 26)

Put this file in the repo at `docs/superpowers/specs/2026-09-26-bisect-autopilot-immune-design.md`. It is the single source of truth for today. It **replaces** the earlier version of this file.

---

## 1. Pitch

> Self-improving agents also teach themselves bad habits. **Bisect** finds the exact rule the agent learned that broke things, verifies it with fresh runs with and without that rule, and removes only that one, keeping everything else the agent learned. Then it **remembers**: every conviction becomes an antibody, so when the agent tries to re-learn the same bad habit in new words, it's recognized and blocked in seconds instead of re-investigated. It all runs on autopilot.

**What stays unique to Bisect (say these every time):**
1. **Pinpoints the exact responsible rule** by searching the agent's version history.
2. **Verifies before blaming:** fresh runs with and without the suspect rule (for example 5/5 vs 0/5).
3. **Selective repair:** removes only that rule and re-checks everything else the agent learned. A rollback would throw away every good lesson learned after the bad one.
4. **Never debugs the same bug twice:** convictions become antibodies and permanent tests, stored and searched in MongoDB Atlas.

**Headline number:** first catch = one full investigation (time, runs) vs repeat catch = one antibody replay (target under 15 s, 5 runs). **Both measured today**; yesterday's dry-run numbers are never shown as results.

**Why it's new (for Q&A):** a May 2026 study found all 7 memory frameworks it tested got worse after their peak, largely from overgeneralized lessons ([arXiv 2605.12978](https://arxiv.org/abs/2605.12978)). The closest prior work retires a bad skill but doesn't block new, similar ones ([arXiv 2608.12851](https://arxiv.org/abs/2608.12851)). Memory-versioning work keeps a straight-line history without dependency tracking ([arXiv 2607.27773](https://arxiv.org/abs/2607.27773)). Say "we haven't found a system that turns a verified diagnosis into a permanent, searchable defense," never "nobody has built this."

---

## 2. Build rules

- **Repo:** `github.com/sahilmehta17/MongoDB_Hackathon_Sept26_Bisect`. All commits and pushes go here.
- **Code is written fresh today.** Yesterday's dry run (`~/Desktop/bisect`, commit `3afa75d`) is **read-only reference**: read it to understand the design, decisions and pitfalls, then write new code. Don't copy files or paste large chunks.
- **Hand-written data is reused as-is** (team decision): the 45 tasks, the store snapshot, house rules, the lesson seed (useful U-lessons and planted H1–H3), prompts, and tool descriptions. Copy them in **one** commit titled `Reuse Sep 25 hand-written data (tasks, rules, lessons, prompts); code written fresh today`. Don't edit the reused lesson seed; its wordings were tuned yesterday.
- **Database:** database `bisect` on today's new cluster `cluster0.hq7hit.mongodb.net` (M10, created Sep 26). The protection against touching yesterday's data is the **cluster host**, not the database name: the app refuses to start if the connection string points at yesterday's cluster (`bisect.mrr9bdi`) or at `cluster0.gexvbm`. The old deployment (`bisect-rho.vercel.app`) stays untouched as a backup.
- **Vercel:** a new project linked to the new repo, with its env vars pointing at database `bisect` on `cluster0.hq7hit`.
- **Honest labels:** `natural`, `planted` (submitted through the gate), `injected` (bypassed the gate), `visitor` (submitted through the gate). Every number says whether it is "screened (2 trials)" or "confirmed (5 trials)".
- **Code freeze 6:00 PM.**

### Carry over yesterday's lessons (from the handoff, sections 5 and 6)

Build these in from the start:
- The `issue_refund` tool description tells the agent to check payment status after a timeout (without it, the no-lesson agent double-refunds on its own).
- **Mid-run lesson lookup:** retrieve lessons at the start of a run, plus one more whenever a tool call fails (a timeout lesson can never match the opening message). Frozen mode picks only from the frozen list.
- The re-check set must cover every kind of request (the `inv25` bug accepted a bad fix because damaged-item requests were missing).
- The "without the lesson" comparison is today's agent minus only the suspect.
- Temperature 0 isn't fully deterministic through OpenRouter, so every shown number is re-measured after the freeze.
- A deploy without env vars silently ran a stub agent yesterday. **The app must refuse to run agent tasks if keys are missing** (no stub fallback in production), and `/api/health` must show which build and database it's using.

---

## 3. Scope and stages

Built in this order, because each stage depends on the one before and the wow must not depend on the riskiest part.

| Stage | Deliverable | Deadline | If it slips |
|---|---|---|---|
| **0. Setup** | Docs, data, `CLAUDE.md`, scaffold, Atlas, Vercel deploy, health green | 12:00 | Nothing else starts until this is done |
| **1. Agent** | Store + 7 tools + faults, checker, runner, lessons/versions/retrieval, run records | 1:15 | Cut the store-credit workflow first |
| **2. Bisect core** | Trials + classify, history builder, investigation workflow (search, four-way verify, selective undo, re-check, acceptance), results page | 2:30 | Results page as plain tables; H1 only |
| **3. Immune memory (the wow)** | Antibodies, pinned tests, recognition + calibration, `/immune` with "Propose a rule" | 3:45 | Antibodies + pinned tests without similarity recognition |
| **4. Autopilot** | Active pointer, gate, monitoring, loop workflow, demo branch, `/autopilot` page | 5:15 | **Hard fallback at 5:00:** a "Run monitoring" button that confirms a regression and starts the investigation automatically; cut the rest |
| **Polish** | Home page, labels, simple trace view | 5:45 | Skip |
| **Cut today** | Lesson rewrite, lineage check, multiverse grid, non-lesson settings, two stores, MCP server, Strands, any Statement Two claim | | |

"Propose a rule" on `/immune` doubles as the Sept 30 booth game (visitors try to sneak a reworded bad rule past it), so no separate stretch work is needed for it.

---

## 4. Evidence rules (fixed before any run; never tuned mid-run)

| Decision | Sample | Rule |
|---|---|---|
| **Screen** | 2 trials per task | Both pass → screened OK. **Any failure** on a previously GOOD task → escalate to Confirm. Infra error → rerun (max 2), else `insufficient_evidence` = not OK |
| **Confirm (classify)** | 5 trials | All 5 pass every assertion → GOOD. 3+ fail the target assertion → BAD. Anything else → INCONCLUSIVE. Other failures never count toward BAD. More than 2 infra errors → INCONCLUSIVE |
| **Verify a suspect** | Confirm on 4 configurations | Parent GOOD, introducing version BAD, current BAD, current minus suspect (frozen retrieval, no backfill) GOOD → `verified`; anything else → `inconclusive` |
| **Accept a repair** | Frozen re-check list (max 16 tasks, every kind of request covered, batches of 3) + pinned set | Failing task GOOD, every previously GOOD task still GOOD → activate; otherwise `awaiting_decision` |
| **Create an antibody** | Verdict `verified` | Created whether or not the repair was accepted |
| **Immune block** | Antibody's failing case, Confirm on the candidate, same target assertion | BAD → `immune_blocked`. GOOD or INCONCLUSIVE → continue to the normal gate (never block on weak evidence) |
| **Activate a candidate** (autopilot) | Triggering task Confirm = GOOD; gate set and pinned set screened OK (or confirmed GOOD after escalation) | Otherwise reject, logged with evidence |
| **Regression detected** (autopilot) | Monitoring task screens not-OK → Confirm | BAD → investigate; GOOD → `false_alarm` |

**Built correctly from the start (no later fix-up step):**
- Every paid trial has a fixed `runId` (for example `inv3-p2-t4`) and is skipped if already saved; `saveRun` upserts.
- Counts are derived from run records (or written atomically with them), so a retry never double-counts.
- **Budget reservation:** reserve n runs with one conditional atomic update before starting them; record actual use afterward.
  ```ts
  const ok = await budgets.findOneAndUpdate(
    { _id, reservedRuns: { $lte: MAX_RUNS - n } },
    { $inc: { reservedRuns: n } },
  );
  if (!ok) throw new FatalError("budget"); // nothing started
  ```
- Limits: 12 tool calls per run; max 2 infra retries per trial; per investigation 300 runs and 1,500 model calls.
- No randomness, clocks or database calls inside `"use workflow"` functions; only in steps. Parallel trials: at most 5 at a time.

---

## 5. Stages 1–2: the core rebuild

Refer to `docs/reference/2026-09-24-spec-and-implementation-plan.pdf` (design intent) and the dry-run code (behavior); the handoff is the tie-breaker for how it ended up. Minimum module set:

| Module | Job |
|---|---|
| `lib/store/sim.ts` | In-memory store copied from the snapshot per run; 7 tools; faults `timeout_first_call`, `timeout_after_commit`, `out_of_stock`; tool log |
| `lib/agent/checker.ts` | Plain-code assertions on final state and tool log, looked up by name; every assertion's result saved |
| `lib/agent/runner.ts` | `runTask`: lessons at start + mid-run lookup, frozen mode, 12-step cap, full transcript, run record, infra errors throw |
| `lib/memory/*` | Atlas client (one per module), collections, `addLesson` (with embedding, wait until searchable), `createVersion` (immutable, one change), `retrieveLessons` (`$vectorSearch` filtered to the version's active lessons) |
| `lib/bisect/trials.ts` | `runTrials`, `classify`, budget reservation |
| `lib/bisect/recheck.ts` | Re-check set builder (lesson-about + similar + used-before + ≥2 per kind + random controls, max 16) |
| `workflows/investigate.ts` | Confirm endpoints (`goodVersionId` input) → binary search (skip on INCONCLUSIVE; bounded linear scan on contradiction) → four-way verify → repair candidate → re-check → acceptance → antibody (stage 3) |
| `scripts/check-data.ts` | Offline checker self-test (scenarios with known answers) |
| `scripts/build-history.ts` | Histories with useful lessons one per version and a planted H-lesson at a fixed position, recorded as ground truth |
| `app/investigations/[id]` | Results page: version timeline with probe labels and counts, the four-way evidence table, repair and re-check results, cost and time; each run opens a simple trace (tool calls with results, lessons seen, checks) |

**Checkpoint 1:15:** a refund task runs end to end on the deployed app; checker results match a hand-read of the tool log; a quick zero-lesson eval lands roughly in the 40–70% range.
**Checkpoint 2:30:** an H1 investigation on a fresh history finds the planted lesson, verifies it, repairs it and passes acceptance, on Vercel; time and runs recorded. Then H2, H3 if time.

---

## 6. Stage 3: immune memory (the wow)

### 6.1 Antibodies (`antibodies` collection)

Created whenever an investigation's verdict is `verified`:

```ts
type Antibody = {
  antibodyId: string;                 // "ab1", ...
  investigationId: string;
  convictedLessonId: string;
  lessonText: string;
  embedding: number[];                // same embedding model as lessons
  failingTaskId: string;
  targetAssertion: string;            // e.g. "no_duplicate_refund"
  evidence: { withFails: number; withoutFails: number; trials: number };
  repair: "removed" | "awaiting_decision";
  label: "natural" | "planted" | "injected";
  createdAt: Date;
  recognitions: number;
  blocks: number;
};
```

Vector Search index on `antibodies.embedding` (cosine). The investigation page ends with an "Antibody created" card linking to `/immune`.

### 6.2 Pinned tests

Each antibody adds `(failingTaskId, targetAssertion)` to the **pinned set**. Every candidate and every repair screens the whole pinned set.

### 6.3 Recognition (runs first for any proposed lesson)

1. Embed the proposed text; `$vectorSearch` antibodies, top 3, score ≥ `IMMUNE_THRESHOLD`.
2. No match → normal gate (or, on `/immune`, "no known bad habit matched").
3. Match → replay the antibody's failing case on the candidate (the base version plus the proposed lesson), Confirm with 5 trials on its target assertion. Top match first; if it isn't BAD, try the next.
4. BAD → `immune_blocked`: record similarity, time from proposal to block, runs used; increment `recognitions` and `blocks`.
5. Otherwise → `immune_passed` ("resembled ab1 but passed its case"); increment `recognitions`; continue.

Similarity only chooses *which* case to replay; fresh runs decide the block. A false match costs 5 runs, never a wrong block.

### 6.4 Calibration and holdout

- `data/immune_calibration.yaml`: 3 rewordings per convicted rule, plus the useful lessons. `scripts/calibrate-immune.ts` prints every similarity and picks a threshold with margin; record it in `docs/immune-threshold.md`. **Fixed after calibration.**
- **Holdout:** the teammate keeps 5–6 extra rewordings that are never used for calibration. They're tested only after the threshold is fixed, and reported as-is.

### 6.5 `/immune` page

- Antibody cards: convicted rule, with/without counts, linked investigation, recognitions and blocks.
- Pinned test count.
- **"Propose a rule":** pick a base version and a rule (menu of prewritten rules; free text, 200 characters max, only if time) → recognition → result with traces. Label submissions `visitor`.
- Recognition feed, newest first.
- **Headline panel:** first catch (investigation time and runs) vs repeat catch (replay time and runs), both measured.

**Checkpoint 3:45:** a reworded H1 rule is `immune_blocked` in seconds via "Propose a rule," shown next to the original investigation's time and runs; a similar-but-useful lesson passes its replay.

---

## 7. Stage 4: autopilot

- **Versions:** active lessons plus `change: { op: "add" | "remove", lessonId }` and `label`. Session has `activeVersionId` and at most one `candidateVersionId`.
- **Task sets** (`data/autopilot_sets.yaml`, fixed, non-overlapping, drafted by the teammate): **gate set** of 8 eval tasks and **monitoring set** of 8 different eval tasks, each covering every house rule and fault type. Pinned set from antibodies.
- **Loop** (Vercel Workflow; every real piece of work is a step):
  ```
  next training request → run on active version → failed? → propose ONE lesson (validated JSON)
    → immune check (6.3) → blocked? stop
    → gate: confirm triggering task + screen gate set + pinned set → activate or reject
    → every 3 activations: screen monitoring set → confirm → BAD → investigate (stage 2)
    → verified → antibody → repair → acceptance → activate and resume, or awaiting_decision
  ```
- **Demo branch** (labelled, never tuned to pass): (1) a planted harmful lesson the gate set covers → blocked by the gate; (2) a planted harmful lesson only the monitoring set covers (chosen by checking coverage; if none exists, injected and labelled "bypassed the gate") → caught by monitoring, investigated, antibody created; (3) a reworded version of (2), submitted through the gate → `immune_blocked`.
- **Session document** (`autopilot_sessions`): pointers, stream position, budget reservation, `events[]` (`proposed`, `immune_blocked`, `immune_passed`, `gate_passed`, `gate_rejected`, `activated`, `monitor_ok`, `false_alarm`, `regression_confirmed`, `investigation_started`, `antibody_created`, `repair_activated`, `awaiting_decision`, `budget_stop`, `insufficient_evidence`), each with evidence counts and timing.
- **`/autopilot/[id]`:** status, pointers, budget; timeline of events with labels and a shield icon for immune events; gate and monitoring grids with trace links; Approve / Reject when waiting.
- **API:** `POST /api/autopilot` (returns the running demo session instead of starting a second), `GET /api/autopilot/[id]`, `POST /api/autopilot/[id]/decision`.

**Hard fallback at 5:00:** if the loop isn't end to end, ship `POST /api/monitor`, which screens the monitoring set on a given version, confirms, and starts the investigation automatically. Present it as "regressions trigger Bisect automatically."

---

## 8. Timeline

| Time | Work | Checkpoint |
|---|---|---|
| 11:30–12:00 | Stage 0: docs + data commits, `CLAUDE.md`, keys, scaffold (Next.js + `withWorkflow`), Atlas `bisect` on `cluster0.hq7hit`, Vercel project, health route | **12:00: deployed, health green** |
| 12:00–1:15 | Stage 1, in parallel worktrees: (a) store + checker + `check-data`, (b) memory layer; then runner | **1:15: a task runs end to end on Vercel** |
| 1:15–2:30 | Stage 2: trials/classify/budget, history builder, investigation workflow, results page | **2:30: H1 verified and repaired on Vercel** |
| 2:30–3:45 | Stage 3: antibodies, pinned tests, recognition, calibration, `/immune` | **3:45: reworded rule blocked in seconds** |
| 3:45–5:15 | Stage 4: autopilot (hard fallback decision at 5:00) | **5:15: demo session end to end, or fallback shipped** |
| 5:15–5:45 | Polish: home page cards, labels, trace view | |
| 5:45–6:00 | Deploy, health check, backup (`bisect-rho`) still up | **6:00 freeze** |
| 6:00–7:30 | `scripts/measure-all.ts` regenerates every on-screen number into one JSON file the screens read | |
| 7:30–9:30 | Slides, rehearse ×3, backup video, booth kit, README, submit | |

---

## 9. Measurement (`scripts/measure-all.ts`, after the freeze; changes no app code)

- Viability on today's build: zero-lesson pass rate, useful-lesson pass rate, harmful lessons biting, investigation time/runs/calls, pass rate after undo.
- Each investigation: correct culprit vs ground truth, probes, runs, calls, tokens, minutes.
- **Immune memory:** first catch vs repeat catch; calibration margin; holdout rewordings blocked out of total; similar-but-useful lessons that matched and then passed.
- Autopilot (or fallback): proposals, immune blocks, gate rejections, activations, regressions caught, repairs, detection-to-repair time.

---

## 10. Story for judges

| Statement One | Bisect |
|---|---|
| Self-improving harness | The agent writes its own rules from real failures; each is a versioned change in MongoDB Atlas |
| Evolves automatically | Autopilot on Vercel Workflows: propose → immune check → gate → activate → monitor → **Bisect** → repair → resume |
| Updating rules and guardrails | **Bisect** removes exactly the harmful rule; each conviction becomes a permanent test and an antibody that guards all future self-edits |
| Recursive | The system improves its own self-improvement: every bug it debugs makes the next one cheaper to stop |
| Hard metric signals | All decisions use plain-code checks and fresh runs, never AI grading |

**3-minute demo:**
1. **Setup (20 s):** the agent learns its own rules on autopilot; a useful rule accepted, a harmful one blocked at the gate.
2. **The regression (25 s):** a rule that got past the gate breaks something; monitoring turns red, confirmed 5/5, Bisect starts itself.
3. **Bisect finds and verifies (50 s):** the search narrows to one rule; with it 5/5 double refunds, without it 0/5.
4. **Selective repair (25 s):** only that rule removed; everything else still passes. "A rollback would have thrown away every good lesson since."
5. **The wow (40 s):** the agent tries to re-learn the same habit in new words: recognized, replayed, blocked in N seconds, next to "first time: M seconds, K runs."
6. **Close (20 s):** "Bisect never debugs the same bug twice." MongoDB Atlas holds the memory and the antibodies; Vercel Workflows run it durably; OpenRouter runs the models; every number measured today.

**30-second booth pitch:**
> "Agents that teach themselves also learn bad habits. Bisect finds the exact bad rule, proves it with fresh runs, and removes only that one. Then it remembers: try to sneak the same bad rule back in, in any wording you like, and watch it get caught in seconds."
