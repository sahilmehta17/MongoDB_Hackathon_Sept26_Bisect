// Learning: after a failed run, a reflection step reads the supervisor's feedback and proposes at
// most one lesson. The reply must be JSON and pass validation, or nothing is proposed.
import { getAgentConfig } from "@/lib/data";
import { llm, MODEL } from "@/lib/llm";
import type { RunRecord, Task } from "@/lib/types";

const MAX_CHARS = 200;
// Order ids (A01..Z99), customer ids (C01..) and exact item ids make a rule specific to one case.
const CASE_SPECIFIC = /\b[A-Z]\d{2}\b|\b[A-Z]\d{2}-I\d\b/;

export type Proposal = { rule: string } | { rule: null; reason: string };

export function validateRule(raw: unknown): Proposal {
  if (!raw || typeof raw !== "object" || !("rule" in raw)) return { rule: null, reason: "reply was not {\"rule\": ...}" };
  const rule = (raw as { rule: unknown }).rule;
  if (rule === null) return { rule: null, reason: "the model proposed no rule" };
  if (typeof rule !== "string") return { rule: null, reason: "rule was not a string" };
  const text = rule.replace(/\s+/g, " ").trim();
  if (text.length < 10) return { rule: null, reason: "rule too short" };
  if (text.length > MAX_CHARS) return { rule: null, reason: `rule longer than ${MAX_CHARS} characters` };
  if (CASE_SPECIFIC.test(text)) return { rule: null, reason: "rule names a specific order or customer" };
  if (/^none\b/i.test(text)) return { rule: null, reason: "the model proposed no rule" };
  return { rule: text };
}

export async function proposeLesson(run: RunRecord, task: Task): Promise<Proposal & { tokens: number }> {
  if (run.error) return { rule: null, reason: "run had an infrastructure error", tokens: 0 };
  if (run.assertions.every((a) => a.passed)) return { rule: null, reason: "run passed", tokens: 0 };
  if (!task.feedbackOnFail) return { rule: null, reason: "task has no supervisor feedback", tokens: 0 };
  const cfg = await getAgentConfig();
  const trace = run.toolCalls.map((c, i) => `${i + 1}. ${c.tool}(${JSON.stringify(c.args)}) -> ${JSON.stringify(c.result)}`).join("\n");
  const reply = String(run.finalStateSummary.finalReply ?? "");
  const res = await llm().chat.completions.create({
    model: MODEL,
    temperature: 0,
    max_tokens: 150,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: `${cfg.reflectSystem}\nAnswer as JSON: {"rule": "<the rule>"} or {"rule": null}.` },
      {
        role: "user",
        content:
          `Customer request:\n${task.request}\n\nAgent's tool calls:\n${trace || "(none)"}\n\n` +
          `Agent's reply to the customer:\n${reply || "(none)"}\n\nSupervisor feedback:\n${task.feedbackOnFail}`,
      },
    ],
  });
  const tokens = res.usage?.total_tokens ?? 0;
  let parsed: unknown;
  try {
    parsed = JSON.parse(res.choices[0]?.message?.content ?? "");
  } catch {
    return { rule: null, reason: "reply was not valid JSON", tokens };
  }
  return { ...validateRule(parsed), tokens };
}
