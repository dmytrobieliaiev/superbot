import OpenAI from 'openai';
import { env } from '../config/env.js';
import { logger } from '../logger.js';
import { llm, llmModel } from './client.js';

const CRITIC_PROMPT = `You are a critic reviewing an AI agent's response to a user.

Score each dimension 0-3:
- helpful: did the response address what the user asked?
- correct: are factual claims accurate (when verifiable)?
- grounded: are claims tied to specific sources/data (tool results, memory, citations) rather than fabricated?

Decide an action:
- "ship" — response is good, send as-is
- "ship_with_caveat" — response is mostly good but should warn user about uncertainty; provide a 1-sentence caveat
- "retry" — response is weak; provide concrete feedback (2-3 sentences) for the agent to incorporate on next attempt

Be strict but practical. Don't request retries for minor stylistic issues. Only retry when content is materially weak.

Return JSON:
{
  "helpful": 0-3,
  "correct": 0-3,
  "grounded": 0-3,
  "action": "ship" | "ship_with_caveat" | "retry",
  "caveat": "<sentence>",         // when action is ship_with_caveat
  "feedback": "<2-3 sentences>"   // when action is retry
}`;

export type CriticAction = 'ship' | 'ship_with_caveat' | 'retry';

export interface Critique {
  helpful: number;
  correct: number;
  grounded: number;
  avg_score: number;
  action: CriticAction;
  caveat: string | undefined;
  feedback: string | undefined;
}

interface RawCritique {
  helpful?: number;
  correct?: number;
  grounded?: number;
  action?: string;
  caveat?: string;
  feedback?: string;
}

// Use judge model/endpoint if configured (avoids self-grading bias).
// Falls back to main LLM otherwise.
let _client: OpenAI | null = null;
function client(): OpenAI {
  if (_client) return _client;
  if (env.JUDGE_API_KEY) {
    const cfg: ConstructorParameters<typeof OpenAI>[0] = {
      apiKey: env.JUDGE_API_KEY,
      maxRetries: 2,
      timeout: 60_000,
    };
    if (env.JUDGE_BASE_URL) cfg.baseURL = env.JUDGE_BASE_URL;
    _client = new OpenAI(cfg);
  } else {
    _client = llm;
  }
  return _client;
}

function model(): string {
  return env.JUDGE_MODEL ?? llmModel;
}

function clamp(n: number): number {
  if (!Number.isFinite(n) || n < 0) return 0;
  if (n > 3) return 3;
  return Math.round(n);
}

function normalizeAction(s: string | undefined): CriticAction {
  if (s === 'retry' || s === 'ship_with_caveat' || s === 'ship') return s;
  return 'ship';
}

export async function critiqueResponse(opts: {
  userInput: string;
  agentResponse: string;
  contextSummary?: string;
}): Promise<Critique> {
  try {
    const contextPart = opts.contextSummary
      ? `\n\nContext the agent had access to:\n${opts.contextSummary.slice(0, 4000)}`
      : '';
    const resp = await client().chat.completions.create({
      model: model(),
      messages: [
        { role: 'system', content: CRITIC_PROMPT },
        {
          role: 'user',
          content: `User asked:\n${opts.userInput}${contextPart}\n\nAgent responded:\n${opts.agentResponse}`,
        },
      ],
      response_format: { type: 'json_object' },
    });
    const text = resp.choices[0]?.message?.content ?? '{}';
    let parsed: RawCritique;
    try {
      parsed = JSON.parse(text) as RawCritique;
    } catch {
      parsed = {};
    }
    const helpful = clamp(parsed.helpful ?? 0);
    const correct = clamp(parsed.correct ?? 0);
    const grounded = clamp(parsed.grounded ?? 0);
    let action = normalizeAction(parsed.action);

    // Hard floor: if any dimension is 0 and action is 'ship', escalate to retry.
    if (action === 'ship' && (helpful === 0 || correct === 0 || grounded === 0)) {
      action = 'retry';
    }

    return {
      helpful,
      correct,
      grounded,
      avg_score: (helpful + correct + grounded) / 3,
      action,
      caveat: parsed.caveat,
      feedback: parsed.feedback,
    };
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'critic_failed');
    // Fail open — ship anyway to avoid blocking the user
    return {
      helpful: 2,
      correct: 2,
      grounded: 2,
      avg_score: 2,
      action: 'ship',
      caveat: undefined,
      feedback: undefined,
    };
  }
}

export function formatCriticFeedbackBlock(c: Critique): string {
  const fb = c.feedback ?? 'be more specific and grounded';
  return `<critic_feedback>Previous attempt scored helpful=${c.helpful}/3, correct=${c.correct}/3, grounded=${c.grounded}/3.\nReviewer feedback: ${fb}\nImprove the response on the dimensions scored lowest.</critic_feedback>`;
}
