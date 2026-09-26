import OpenAI from "openai";
import { requireEnv } from "@/lib/env";

// Every model call goes through OpenRouter, with one fixed model per experiment.
let client: OpenAI | null = null;

export function llm(): OpenAI {
  if (!client) {
    client = new OpenAI({
      apiKey: requireEnv("OPENROUTER_API_KEY"),
      baseURL: "https://openrouter.ai/api/v1",
      defaultHeaders: { "X-Title": "Bisect" },
      maxRetries: 3, // backs off on 429 / 5xx
    });
  }
  return client;
}

export const MODEL = process.env.OPENROUTER_MODEL?.trim() || "openai/gpt-4.1-mini";
