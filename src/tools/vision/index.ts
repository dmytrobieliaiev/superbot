import { env } from '../../config/env.js';
import { llm } from '../../llm/client.js';
import { logger } from '../../logger.js';
import type { ToolResult, ToolSpec } from '../types.js';

interface VisionArgs {
  image_urls: string[];
  prompt: string;
}

export const vision: ToolSpec<VisionArgs> = {
  name: 'vision',
  description:
    'Analyze one or more images using a multimodal LLM. Pass public URLs; for Slack uploads, fetch their permalink first.',
  params_schema: {
    type: 'object',
    properties: {
      image_urls: {
        type: 'array',
        items: { type: 'string', format: 'uri' },
        minItems: 1,
        maxItems: 5,
      },
      prompt: { type: 'string', description: 'What to analyze / describe' },
    },
    required: ['image_urls', 'prompt'],
    additionalProperties: false,
  },
  cost_estimate: () => 0.01,
  async execute(args, _ctx): Promise<ToolResult> {
    const started = Date.now();
    const model = env.LLM_MODEL;
    try {
      const resp = await llm.chat.completions.create({
        model,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: args.prompt },
              ...args.image_urls.map((url) => ({
                type: 'image_url' as const,
                image_url: { url },
              })),
            ],
          },
        ],
      });
      const text = resp.choices[0]?.message?.content ?? '(no response)';
      return {
        status: 'ok',
        content: typeof text === 'string' ? text : JSON.stringify(text),
        meta: { latency_ms: Date.now() - started, cost_usd: 0.01, cache_hit: false },
      };
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'vision failed');
      return {
        status: 'error',
        content: `vision error: ${(err as Error).message}`,
        error: (err as Error).message,
        meta: { latency_ms: Date.now() - started, cost_usd: 0, cache_hit: false },
      };
    }
  },
};
