"use client";

// The trace of one run: the customer's request, the lessons the agent saw, each tool call with its
// result, mid-run lesson reminders, the final reply, every check, and the final store state.
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { RunRecord, TranscriptMessage } from "@/lib/types";
import { LIMITS } from "@/lib/types";

type LoadState =
  | { kind: "loading" }
  | { kind: "notfound" }
  | { kind: "error"; message: string }
  | { kind: "ready"; run: RunRecord };

async function errorText(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body.error === "string") return `${body.error} (HTTP ${res.status})`;
  } catch {
    // not JSON; fall through
  }
  return `HTTP ${res.status} ${res.statusText}`.trim();
}

function useRun(runId: string) {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/runs/${encodeURIComponent(runId)}`, { cache: "no-store" });
        if (cancelled) return;
        if (res.status === 404) return setState({ kind: "notfound" });
        if (!res.ok) throw new Error(await errorText(res));
        const run = (await res.json()) as RunRecord;
        if (!cancelled) setState({ kind: "ready", run });
      } catch (e) {
        if (!cancelled) setState({ kind: "error", message: e instanceof Error ? e.message : String(e) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [runId, attempt]);
  const retry = useCallback(() => {
    setState({ kind: "loading" });
    setAttempt((n) => n + 1);
  }, []);
  return { state, retry };
}

// ---------- building the step list ----------

type Step =
  | { kind: "call"; n: number; tool: string; args: unknown; result: unknown; failed: boolean; note: string | null }
  | { kind: "reminder"; text: string }
  | { kind: "say"; text: string };

function parseJson(s: string | null | undefined): unknown {
  if (s == null) return null;
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

function isFailure(result: unknown): boolean {
  if (result === "timeout") return true;
  return typeof result === "object" && result !== null && typeof (result as { error?: unknown }).error === "string";
}

// Walks the transcript after the customer's message. Falls back to the plain tool log when the
// transcript has no tool calls in it.
function buildSteps(run: RunRecord, finalIdx: number): Step[] {
  const t = run.transcript ?? [];
  const firstUser = t.findIndex((m) => m.role === "user");
  const toolMsgs = new Map<string, TranscriptMessage>();
  for (const m of t) if (m.role === "tool" && m.toolCallId) toolMsgs.set(m.toolCallId, m);

  const steps: Step[] = [];
  let n = 0;
  for (let i = firstUser + 1; i < t.length; i++) {
    const m = t[i];
    if (i === finalIdx) continue;
    if (m.role === "system" && m.midRun) steps.push({ kind: "reminder", text: m.content ?? "" });
    else if (m.role === "assistant") {
      if (m.content && m.toolCalls?.length) steps.push({ kind: "say", text: m.content });
      for (const c of m.toolCalls ?? []) {
        const res = toolMsgs.get(c.id);
        const result = res ? parseJson(res.content) : undefined;
        steps.push({
          kind: "call",
          n: ++n,
          tool: c.name,
          args: parseJson(c.arguments),
          result,
          failed: isFailure(result),
          note: res ? null : "not executed (step limit reached)",
        });
      }
    }
  }
  if (n === 0 && run.toolCalls?.length) {
    return run.toolCalls.map((c, i) => ({
      kind: "call",
      n: i + 1,
      tool: c.tool,
      args: c.args,
      result: c.result,
      failed: isFailure(c.result),
      note: null,
    }));
  }
  return steps;
}

// ---------- formatting ----------

function Json({ value }: { value: unknown }) {
  if (value === undefined) return <span className="muted">no result</span>;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return (
    <pre className="json">
      <span className="muted">result: </span>
      {text}
    </pre>
  );
}

function argsInline(args: unknown): string {
  if (args && typeof args === "object" && !Array.isArray(args)) {
    return Object.entries(args as Record<string, unknown>)
      .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
      .join(", ");
  }
  return typeof args === "string" ? args : JSON.stringify(args);
}

const humanKey = (k: string) => k.replace(/_/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();

function stateValue(v: unknown): string {
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (typeof v === "number") return v.toLocaleString("en-US");
  if (typeof v === "string") return v;
  return JSON.stringify(v);
}

const OUTCOME: Record<string, { text: string; tone: string }> = {
  pass: { text: "Passed every check", tone: "good" },
  target_fail: { text: "Broke the rule under investigation", tone: "bad" },
  other_fail: { text: "Failed another check", tone: "warn" },
  error: { text: "Infrastructure error", tone: "warn" },
};

// ---------- page ----------

export default function RunTrace({ runId }: { runId: string }) {
  const { state, retry } = useRun(runId);
  if (state.kind === "loading") {
    return (
      <main className="report" aria-busy="true">
        <p className="status-msg">Loading run {runId}…</p>
      </main>
    );
  }
  if (state.kind === "notfound") {
    return (
      <main className="report">
        <div className="notice notice-warn">
          <h1>No run with that id</h1>
          <p>
            Nothing is saved under <code>{runId}</code>. <Link href="/">Go to the start page</Link>.
          </p>
        </div>
      </main>
    );
  }
  if (state.kind === "error") {
    return (
      <main className="report">
        <div className="notice notice-bad" role="alert">
          <h1>Couldn&apos;t load run {runId}</h1>
          <p>{state.message}</p>
          <button type="button" className="button" onClick={retry}>
            Try again
          </button>
        </div>
      </main>
    );
  }
  return <Trace run={state.run} />;
}

function Trace({ run }: { run: RunRecord }) {
  const t = run.transcript ?? [];
  const request = t.find((m) => m.role === "user")?.content ?? null;
  const last = t.length - 1;
  const finalIdx = last >= 0 && t[last].role === "assistant" && !t[last].toolCalls?.length ? last : -1;
  const summary = run.finalStateSummary ?? {};
  const reply =
    finalIdx >= 0 ? t[finalIdx].content : typeof summary.finalReply === "string" && summary.finalReply ? summary.finalReply : null;
  const stepLimit = summary.stepLimit === true;
  const steps = buildSteps(run, finalIdx);
  const lessons = [...(run.retrievedLessons ?? [])].sort((a, b) => a.rank - b.rank);
  const stateEntries = Object.entries(summary).filter(([k]) => k !== "finalReply" && k !== "stepLimit");
  const invId = /^(inv\d+)-/.exec(run.runId)?.[1];
  const outcome = run.error ? OUTCOME.error : run.outcome ? OUTCOME[run.outcome] : null;
  const failedChecks = run.assertions.filter((a) => !a.passed).length;

  return (
    <main className="report">
      <header className="report-head">
        <p className="eyebrow">
          <Link href="/">Bisect</Link>
          {invId ? (
            <>
              {" "}
              · <Link href={`/investigations/${invId}`}>investigation {invId}</Link>
            </>
          ) : null}{" "}
          · run trace
        </p>
        <div className="title-row">
          <h1>
            Run <code>{run.runId}</code>
          </h1>
          {outcome ? <span className={`badge badge-${outcome.tone}`}>{outcome.text}</span> : null}
        </div>
        <dl className="facts facts-inline">
          <div>
            <dt>Task</dt>
            <dd>
              <code>{run.taskId}</code>
            </dd>
          </div>
          <div>
            <dt>Version</dt>
            <dd>
              <code>{run.versionId}</code>
              {run.contextMode === "frozen_minus_suspect" ? <span className="muted"> · suspect lesson hidden (frozen lessons)</span> : null}
            </dd>
          </div>
          <div>
            <dt>Trial</dt>
            <dd>{run.trial}</dd>
          </div>
          <div>
            <dt>Checks</dt>
            <dd>
              {run.assertions.length - failedChecks}/{run.assertions.length} passed
            </dd>
          </div>
        </dl>
        {run.error ? (
          <div className="notice notice-bad" role="alert">
            <strong>Infrastructure error:</strong> {run.error}
            {run.infraRetries ? ` (after ${run.infraRetries} retries)` : ""}
          </div>
        ) : null}
      </header>

      <section className="section" aria-labelledby="request">
        <h2 id="request">Customer&apos;s request</h2>
        {request ? <blockquote className="request request-big">“{request}”</blockquote> : <p className="muted">Not in the transcript.</p>}
      </section>

      <section className="section" aria-labelledby="lessons">
        <h2 id="lessons">Lessons the agent saw</h2>
        {lessons.length ? (
          <ol className="lessons">
            {lessons.map((l) => (
              <li key={l.id + l.rank} className={l.trigger ? "lesson-midrun" : ""}>
                <code>{l.id}</code> {l.text}
                {l.trigger ? (
                  <div className="lesson-trigger">
                    <span className="chip chip-warn">looked up mid-run</span> after: {l.trigger}
                  </div>
                ) : null}
              </li>
            ))}
          </ol>
        ) : (
          <p className="muted">None: no lessons were shown to the agent.</p>
        )}
      </section>

      <section className="section" aria-labelledby="steps">
        <h2 id="steps">What the agent did</h2>
        {steps.length ? (
          <ol className="trace">
            {steps.map((s, i) =>
              s.kind === "call" ? (
                <li key={i} className={`trace-step ${s.failed ? "trace-failed" : ""}`}>
                  <div className="trace-head">
                    <span className="trace-num">{s.n}</span>
                    <code className="trace-tool">{s.tool}</code>
                    <code className="trace-args">({argsInline(s.args)})</code>
                    {s.failed ? <span className="chip chip-bad">{s.result === "timeout" || (s.result as { error?: string })?.error === "timeout" ? "timed out" : "failed"}</span> : null}
                  </div>
                  {s.note ? <p className="muted">{s.note}</p> : <Json value={s.result} />}
                </li>
              ) : s.kind === "reminder" ? (
                <li key={i} className="trace-reminder">
                  <span className="chip chip-warn">lesson reminder</span>
                  <p className="pre-line">{s.text}</p>
                </li>
              ) : (
                <li key={i} className="trace-say">
                  <span className="muted">agent: </span>
                  {s.text}
                </li>
              ),
            )}
          </ol>
        ) : (
          <p className="muted">No tool calls.</p>
        )}
        {stepLimit ? (
          <p className="verdict-line verdict-warn">Stopped at the step limit ({LIMITS.maxToolCalls} tool calls).</p>
        ) : null}
      </section>

      <section className="section" aria-labelledby="reply">
        <h2 id="reply">Final reply to the customer</h2>
        {reply ? <blockquote className="reply pre-line">{reply}</blockquote> : <p className="muted">No final reply.</p>}
      </section>

      <div className="two-col">
        <section className="section" aria-labelledby="checks">
          <h2 id="checks">Checks</h2>
          <ul className="checks">
            {run.assertions.map((a) => (
              <li key={a.name} className={a.passed ? "check-pass" : "check-fail"}>
                <span className="check-mark" aria-hidden="true">
                  {a.passed ? "✓" : "✗"}
                </span>
                <code>{a.name}</code>
                <span className="sr-only">{a.passed ? " passed" : " failed"}</span>
                {a.name === run.targetAssertion ? <span className="chip chip-info">rule under investigation</span> : null}
              </li>
            ))}
          </ul>
        </section>
        <section className="section" aria-labelledby="final-state">
          <h2 id="final-state">Final store state</h2>
          {stateEntries.length ? (
            <dl className="kv">
              {stateEntries.map(([k, v]) => (
                <div key={k}>
                  <dt>{humanKey(k)}</dt>
                  <dd>{stateValue(v)}</dd>
                </div>
              ))}
            </dl>
          ) : (
            <p className="muted">Not recorded.</p>
          )}
        </section>
      </div>

      <details className="rawlog">
        <summary>Reproducibility details</summary>
        <dl className="kv">
          <div>
            <dt>model</dt>
            <dd>
              {run.model.name} · temperature {run.model.temperature} · max {run.model.maxTokens} tokens
            </dd>
          </div>
          <div>
            <dt>usage</dt>
            <dd>
              {run.modelCalls} model calls · {run.tokens.toLocaleString("en-US")} tokens · {run.toolSteps} tool steps
            </dd>
          </div>
          <div>
            <dt>lessons active</dt>
            <dd>{run.activeLessonIds.join(", ") || "none"}</dd>
          </div>
          <div>
            <dt>snapshot</dt>
            <dd>{run.snapshotId}</dd>
          </div>
          <div>
            <dt>tool code</dt>
            <dd>{run.toolCodeVersion}</dd>
          </div>
          <div>
            <dt>checker</dt>
            <dd>{run.checkerVersion}</dd>
          </div>
          <div>
            <dt>prompt hash</dt>
            <dd className="break">{run.renderedPromptHash}</dd>
          </div>
          <div>
            <dt>saved</dt>
            <dd>{new Date(run.createdAt).toISOString()}</dd>
          </div>
        </dl>
      </details>

      <details className="rawlog">
        <summary>Raw transcript ({t.length} messages)</summary>
        <ol className="transcript">
          {t.map((m, i) => (
            <li key={i}>
              <span className="chip chip-neutral">
                {m.role}
                {m.midRun ? " · mid-run" : ""}
              </span>
              {m.content ? <p className="pre-line">{m.content}</p> : null}
              {m.toolCalls?.map((c) => (
                <p key={c.id}>
                  <code>
                    {c.name}({c.arguments})
                  </code>
                </p>
              ))}
            </li>
          ))}
        </ol>
      </details>
    </main>
  );
}
