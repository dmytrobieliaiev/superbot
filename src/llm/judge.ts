import OpenAI from 'openai';
import { env } from '../config/env.js';
import { llm, llmModel } from './client.js';

const JUDGE_PROMPT = `You are an evaluator scoring an AI agent's response. Score 3 dimensions, each 0..3:
- helpful: did it address the user's request?
- correct: are the claims accurate?
- grounded: tied to sources/facts, no hallucination?

Return JSON: { "helpful": <int>, "correct": <int>, "grounded": <int>, "note": "<one-sentence rationale>" }`;

export interface JudgeScore {
  helpful: number;
  correct: number;
  grounded: number;
  avg_score: number;
  note: string;
}

interface RawScore {
  helpful?: number;
  correct?: number;
  grounded?: number;
  note?: string;
}

function clamp(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 3) return 3;
  return Math.round(n);
}

// Separate client + model for judging — avoids LLM-as-judge self-grading bias.
// Falls back to main LLM if JUDGE_* env unset.
let _judgeClient: OpenAI | null = null;
function judgeClient(): OpenAI {
  if (_judgeClient) return _judgeClient;
  if (env.JUDGE_API_KEY) {
    const cfg: ConstructorParameters<typeof OpenAI>[0] = {
      apiKey: env.JUDGE_API_KEY,
      maxRetries: 2,
      timeout: 60_000,
    };
    if (env.JUDGE_BASE_URL) cfg.baseURL = env.JUDGE_BASE_URL;
    _judgeClient = new OpenAI(cfg);
  } else {
    _judgeClient = llm;
  }
  return _judgeClient;
}

function judgeModel(): string {
  return env.JUDGE_MODEL ?? llmModel;
}

export async function judgeResponse(
  userInput: string,
  agentOutput: string,
  expectedOutcome: string,
): Promise<JudgeScore> {
  const resp = await judgeClient().chat.completions.create({
    model: judgeModel(),
    messages: [
      { role: 'system', content: JUDGE_PROMPT },
      {
        role: 'user',
        content: `Expected outcome: ${expectedOutcome}\n\nUser input:\n${userInput}\n\nAgent response:\n${agentOutput}`,
      },
    ],
    response_format: { type: 'json_object' },
  });
  const text = resp.choices[0]?.message?.content ?? '{}';
  let parsed: RawScore;
  try {
    parsed = JSON.parse(text) as RawScore;
  } catch {
    parsed = {};
  }
  const helpful = clamp(parsed.helpful ?? 0);
  const correct = clamp(parsed.correct ?? 0);
  const grounded = clamp(parsed.grounded ?? 0);
  return {
    helpful,
    correct,
    grounded,
    avg_score: (helpful + correct + grounded) / 3,
    note: parsed.note ?? '',
  };
}
