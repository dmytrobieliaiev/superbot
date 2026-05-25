import OpenAI from 'openai';
import { env } from '../config/env.js';
import { logger } from '../logger.js';

const baseURL = env.LLM_BASE_URL;
const apiKey = env.LLM_API_KEY;

if (!apiKey) {
  logger.warn('LLM_API_KEY not set — LLM calls will fail at runtime');
}

const clientConfig: ConstructorParameters<typeof OpenAI>[0] = {
  apiKey: apiKey ?? 'missing-key',
  maxRetries: 2,
  timeout: 60_000,
};
if (baseURL) clientConfig.baseURL = baseURL;

export const llm = new OpenAI(clientConfig);

export const llmModel = env.LLM_MODEL;
