import { config } from 'dotenv';
import { z } from 'zod';

config();

// Empty strings in .env should be treated as unset (zod's `.url()` rejects "").
for (const key of Object.keys(process.env)) {
  if (process.env[key] === '') delete process.env[key];
}

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  LLM_BASE_URL: z.string().url().optional(),
  LLM_API_KEY: z.string().optional(),
  LLM_MODEL: z.string().default('opus'),
  EMBED_MODEL: z.string().default('mistral-embed'),
  // Audio transcription — OpenAI-compatible /audio/transcriptions endpoint.
  // Defaults to LLM_BASE_URL + LLM_API_KEY when unset.
  AUDIO_BASE_URL: z.string().url().optional(),
  AUDIO_API_KEY: z.string().optional(),
  AUDIO_MODEL: z.string().default('whisper-1'),
  // Separate endpoint for embeddings — useful when LLM provider doesn't
  // allow OpenAI models (e.g., OpenRouter w/ openai blocked).
  EMBED_BASE_URL: z.string().url().optional(),
  EMBED_API_KEY: z.string().optional(),

  SLACK_BOT_TOKEN: z.string().optional(),
  SLACK_APP_TOKEN: z.string().optional(),
  SLACK_SIGNING_SECRET: z.string().optional(),

  DATABASE_URL: z.string().optional(),
  REDIS_URL: z.string().optional(),
  S3_ENDPOINT: z.string().optional(),
  S3_ACCESS_KEY: z.string().optional(),
  S3_SECRET_KEY: z.string().optional(),
  S3_BUCKET: z.string().default('superbot'),

  // Tool API keys
  TAVILY_API_KEY: z.string().optional(),
  JINA_API_KEY: z.string().optional(),
  EXA_API_KEY: z.string().optional(),
  FIRECRAWL_API_KEY: z.string().optional(),
  GITHUB_TOKEN: z.string().optional(),
  LINEAR_API_KEY: z.string().optional(),
  E2B_API_KEY: z.string().optional(),
  REPLICATE_API_TOKEN: z.string().optional(),
  REPLICATE_MODEL: z.string().optional(),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_REFRESH_TOKEN: z.string().optional(),
  GOOGLE_CALENDAR_ID: z.string().optional(),
  BROWSERLESS_URL: z.string().optional(),
  BROWSERLESS_TOKEN: z.string().optional(),
  GOTENBERG_URL: z.string().optional(),

  // Eval + ops
  MAINTAINER_USER_ID: z.string().optional(),
  AGENT_OPS_CHANNEL: z.string().optional(),
  // Comma-separated Slack user ids allowed to use /admin
  ADMIN_USER_IDS: z.string().optional(),

  // Observability
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().optional(),
  METRICS_PORT: z.coerce.number().int().default(9090),

  // Eval — use a different model to judge (avoids self-grading bias)
  JUDGE_MODEL: z.string().optional(),
  JUDGE_BASE_URL: z.string().optional(),
  JUDGE_API_KEY: z.string().optional(),

  // Critic loop — post-response review + retry on weak output.
  CRITIC_ENABLED: z
    .union([z.string(), z.boolean()])
    .transform((v) => (typeof v === 'boolean' ? v : v === 'true' || v === '1'))
    .default(true),
  // 'inline'        — run critic in-band on every turn before reply (legacy)
  // 'on_negative'   — only run critic when user reacts negatively to a reply (default)
  CRITIC_MODE: z.enum(['inline', 'on_negative']).default('on_negative'),
  CRITIC_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(2),

  // Thread follow-up: after the bot replies in a thread, follow-up messages
  // in that same thread auto-trigger the bot (no @mention required) for this
  // TTL. Set 0 to disable thread follow-up.
  THREAD_FOLLOWUP_TTL_SEC: z.coerce.number().int().min(0).default(4 * 60 * 60),

  // db_query tool — separate analytics DB (defaults to DATABASE_URL if unset)
  ANALYTICS_DATABASE_URL: z.string().optional(),
});

export type Env = z.infer<typeof EnvSchema>;

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment variables:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env: Env = parsed.data;
