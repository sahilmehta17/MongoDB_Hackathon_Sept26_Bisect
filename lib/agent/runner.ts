// runTask(): one task on one version. Retrieves the version's lessons, runs the model's tool loop
// against a fresh copy of the store, checks the result and saves the run record (an upsert on the
// caller's runId). Infrastructure errors throw so the caller can retry them; agent behavior never
// throws. There is no stub mode: without every key the run is refused.
import { createHash } from "node:crypto";
import type OpenAI from "openai";
import { check, CHECKER_VERSION } from "@/lib/agent/checker";
import { outcomeOf } from "@/lib/bisect/evidence";
import { getAgentConfig, getSnapshot, getTask } from "@/lib/data";
import { gitCommit, requireEnv } from "@/lib/env";
import { llm, MODEL } from "@/lib/llm";
import { getVersion, rankWithin, retrieveLessons } from "@/lib/memory/lessons";
import { saveRun } from "@/lib/memory/runs";
import { Store, summarize, TOOL_CODE_VERSION } from "@/lib/store/sim";
import type { AgentConfig, Lesson, RetrievedLesson, RunRecord, RunTaskOpts, TranscriptMessage } from "@/lib/types";
import { LIMITS } from "@/lib/types";

export const RETRIEVE_K = 5; // lessons shown at the start of a run
// One more lesson is looked up whenever a tool call fails, using the failure as the query: a
// lesson about timeouts can never match the customer's opening message.
export const RETRIEVE_ON_ERROR_K = 1;
const TEMPERATURE = 0;
const MAX_TOKENS = 800;

export function assertAgentKeys(): void {
  for (const k of ["MONGODB_URI", "MONGODB_DB", "OPENROUTER_API_KEY", "VOYAGE_API_KEY"]) requireEnv(k);
}

export function systemPrompt(cfg: AgentConfig, today: string, lessons: { text: string }[]): string {
  const lines = cfg.agentSystem.map((l) => l.replaceAll("{today}", today));
  if (lessons.length) lines.push("", cfg.lessonsHeader, ...lessons.map((l) => `- ${l.text}`));
  return lines.join("\n");
}

const sha256 = (s: string) => "sha256:" + createHash("sha256").update(s).digest("hex");

export async function runTask(opts: RunTaskOpts): Promise<RunRecord> {
  assertAgentKeys();
  const contextMode = opts.contextMode ?? "normal";
  if (contextMode === "frozen_minus_suspect" && !opts.frozenLessonIds) {
    throw new Error("frozen_minus_suspect needs frozenLessonIds");
  }
  const [task, cfg, version] = await Promise.all([getTask(opts.taskId), getAgentConfig(), getVersion(opts.versionId)]);
  const snap = await getSnapshot(task.snapshotId);

  // Normal mode searches the version's active lessons. Frozen mode ranks only within the given
  // list, so a removed lesson is never replaced by the next-best one (no backfill).
  const lookup = (query: string, k: number, exclude: Set<string>): Promise<Lesson[]> =>
    contextMode === "frozen_minus_suspect"
      ? rankWithin(opts.frozenLessonIds!.filter((id) => !exclude.has(id)), query, k)
      : retrieveLessons(opts.versionId, query, k, exclude);

  const initial = await lookup(task.request, RETRIEVE_K, new Set());
  const retrieved: RetrievedLesson[] = initial.map((l, i) => ({ id: l.lessonId, text: l.text, rank: i + 1 }));

  const onToolError = async (tool: string, error: string, message?: string): Promise<string | null> => {
    const what = error === "timeout" ? `${tool} timed out` : `${tool} failed: ${error.replace(/_/g, " ")}`;
    const seen = new Set(retrieved.map((r) => r.id));
    const extra = await lookup(`${what}. ${message ?? ""}`.trim(), RETRIEVE_ON_ERROR_K, seen);
    if (!extra.length) return null;
    for (const l of extra) retrieved.push({ id: l.lessonId, text: l.text, rank: retrieved.length + 1, trigger: what });
    return [cfg.midrunLessonsHeader, ...extra.map((l) => `- ${l.text}`)].join("\n");
  };

  const system = systemPrompt(cfg, snap.today, initial);
  const messages: OpenAI.ChatCompletionMessageParam[] = [
    { role: "system", content: system },
    { role: "user", content: task.request },
  ];
  const store = new Store(snap, task.faults ?? {});
  const loop = await agentLoop(messages, cfg, store, onToolError);

  const assertions = [...check(task, store.state, store.log), { name: "within_step_limit", passed: !loop.stepLimit }];
  const code = `git:${gitCommit()}`;
  const record: RunRecord = {
    runId: opts.runId,
    taskId: task.taskId,
    versionId: opts.versionId,
    trial: opts.trial,
    snapshotId: task.snapshotId,
    toolCodeVersion: `${code}/${TOOL_CODE_VERSION}`,
    checkerVersion: `${code}/${CHECKER_VERSION}`,
    model: { name: MODEL, temperature: TEMPERATURE, maxTokens: MAX_TOKENS },
    contextMode,
    activeLessonIds: contextMode === "frozen_minus_suspect" ? [...opts.frozenLessonIds!] : version.activeLessonIds,
    retrievedLessons: retrieved,
    renderedPromptHash: sha256(JSON.stringify({ system, user: task.request, tools: cfg.tools, model: MODEL })),
    toolCalls: store.log,
    toolSteps: store.log.length,
    finalStateSummary: { ...summarize(store.state, task.orderId), finalReply: loop.reply, stepLimit: loop.stepLimit },
    assertions,
    targetAssertion: opts.targetAssertion ?? null,
    outcome: null,
    error: null,
    infraRetries: 0,
    tokens: loop.tokens,
    modelCalls: loop.modelCalls,
    transcript: toTranscript(messages, loop.reply),
    createdAt: new Date(),
  };
  if (opts.targetAssertion) record.outcome = outcomeOf(record, opts.targetAssertion);
  await saveRun(record);
  return record;
}

// The conversation as stored for the trace view.
function toTranscript(messages: OpenAI.ChatCompletionMessageParam[], reply: string): TranscriptMessage[] {
  const out: TranscriptMessage[] = messages.map((m, i) => {
    const content = typeof m.content === "string" ? m.content : m.content == null ? null : JSON.stringify(m.content);
    const t: TranscriptMessage = { role: m.role as TranscriptMessage["role"], content };
    if (m.role === "assistant" && m.tool_calls?.length) {
      t.toolCalls = m.tool_calls
        .filter((c) => c.type === "function")
        .map((c) => ({ id: c.id, name: c.function.name, arguments: c.function.arguments }));
    }
    if (m.role === "tool") t.toolCallId = m.tool_call_id;
    if (m.role === "system" && i > 0) t.midRun = true;
    return t;
  });
  if (reply) out.push({ role: "assistant", content: reply });
  return out;
}

interface LoopResult {
  reply: string;
  stepLimit: boolean;
  tokens: number;
  modelCalls: number;
}

async function agentLoop(
  messages: OpenAI.ChatCompletionMessageParam[],
  cfg: AgentConfig,
  store: Store,
  onToolError: (tool: string, error: string, message?: string) => Promise<string | null>,
): Promise<LoopResult> {
  let tokens = 0;
  let modelCalls = 0;
  // Enough model turns for the tool-call limit plus the final reply.
  for (let turn = 0; turn <= LIMITS.maxToolCalls + 1; turn++) {
    // Any throw here (network, 5xx after the client's own retries, bad key) is infrastructure.
    const res = await llm().chat.completions.create({
      model: MODEL,
      temperature: TEMPERATURE,
      max_tokens: MAX_TOKENS,
      messages,
      tools: cfg.tools,
      tool_choice: "auto",
      parallel_tool_calls: false,
    });
    modelCalls++;
    tokens += res.usage?.total_tokens ?? 0;
    const msg = res.choices?.[0]?.message;
    if (!msg) throw new Error(`model returned no message: ${JSON.stringify(res).slice(0, 200)}`);
    const calls = (msg.tool_calls ?? []).filter((c) => c.type === "function");
    if (!calls.length) return { reply: msg.content ?? "", stepLimit: false, tokens, modelCalls };

    messages.push({ role: "assistant", content: msg.content ?? null, tool_calls: calls });
    for (const c of calls) {
      if (store.log.length >= LIMITS.maxToolCalls) return { reply: "", stepLimit: true, tokens, modelCalls };
      let out: unknown;
      try {
        out = store.call(c.function.name, JSON.parse(c.function.arguments || "{}"));
      } catch {
        // Malformed arguments are the model's behavior, not infrastructure: log it and tell the model.
        store.log.push({ tool: c.function.name, args: { _raw: c.function.arguments }, result: { error: "malformed_arguments" } });
        out = { error: "malformed_arguments", message: "Arguments were not valid JSON." };
      }
      messages.push({ role: "tool", tool_call_id: c.id, content: JSON.stringify(out) });
      const err = out as { error?: unknown; message?: string };
      if (typeof err?.error === "string" && err.error !== "malformed_arguments") {
        const note = await onToolError(c.function.name, err.error, err.message);
        if (note) messages.push({ role: "system", content: note });
      }
    }
  }
  return { reply: "", stepLimit: true, tokens, modelCalls };
}
