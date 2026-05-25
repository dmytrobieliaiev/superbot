import OpenAI from 'openai';
import { env } from '../config/env.js';
import { logger } from '../logger.js';
import { llm } from './client.js';

// Separate client when EMBED_BASE_URL/EMBED_API_KEY set — lets embeddings hit
// a different provider than completions (common: OpenRouter for chat,
// OpenAI direct for text-embedding-3-small).
let _embedClient: OpenAI | null = null;

function embedClient(): OpenAI {
  if (_embedClient) return _embedClient;
  if (env.EMBED_API_KEY) {
    const cfg: ConstructorParameters<typeof OpenAI>[0] = {
      apiKey: env.EMBED_API_KEY,
      maxRetries: 2,
      timeout: 60_000,
    };
    if (env.EMBED_BASE_URL) cfg.baseURL = env.EMBED_BASE_URL;
    _embedClient = new OpenAI(cfg);
  } else {
    _embedClient = llm;
  }
  return _embedClient;
}

export async function embed(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  try {
    const resp = await embedClient().embeddings.create({
      model: env.EMBED_MODEL,
      input: texts,
    });
    return resp.data.map((d) => d.embedding);
  } catch (err) {
    logger.error({ err: (err as Error).message }, 'embed failed');
    throw err;
  }
}

export async function embedOne(text: string): Promise<number[]> {
  const [first] = await embed([text]);
  if (!first) throw new Error('embed returned no vector');
  return first;
}
