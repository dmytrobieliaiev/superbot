import type { Redis } from 'ioredis';
import type OpenAI from 'openai';
import { llmModel } from '../llm/client.js';
import { computeCost } from '../llm/cost.js';
import { streamCompletion, type ProgressCallback } from '../llm/stream.js';
import { logger } from '../logger.js';
import type { ToolExecRecord } from '../memory/trajectory.js';
import {
  downloadSlackFile,
  isSupportedAudio,
  isSupportedImage,
  slackImageToDataUrl,
} from '../slack/download.js';
import type { SlackFile } from '../slack/types.js';
import { transcribeBuffer } from '../tools/audio/transcribe.js';
import { executeTool } from '../tools/execute.js';
import { listForContext, toolDefinitionsForLLM } from '../tools/registry.js';
import type { ToolContext } from '../tools/types.js';

type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;
type UserContentPart = OpenAI.Chat.Completions.ChatCompletionContentPart;

interface RunOpts {
  redis: Redis;
  ctx: ToolContext;
  systemPrompt: string;
  contextBlocks: string[];
  userText: string;
  /** Slack files attached to the inbound message. Image files are inlined as vision input. */
  userFiles?: SlackFile[];
  /** Fires for each text delta from the LLM as it streams in. */
  onProgress?: ProgressCallback;
}

async function buildUserMessage(
  userText: string,
  files: SlackFile[] | undefined,
): Promise<ChatMessage> {
  const all = files ?? [];
  const images = all.filter((f) => isSupportedImage(f.mimetype));
  const audios = all.filter((f) => isSupportedAudio(f.mimetype));

  // Transcribe audio attachments upfront so the agent sees them as text.
  const transcripts: string[] = [];
  for (const f of audios) {
    try {
      const buf = await downloadSlackFile(f.url_private);
      const { text } = await transcribeBuffer(buf, f.name, f.mimetype);
      const clean = text.trim();
      logger.info(
        { file_id: f.id, mimetype: f.mimetype, len: clean.length },
        'slack_audio_transcribed',
      );
      transcripts.push(
        `[voice message "${f.name}" (${f.mimetype}) transcript]\n${clean || '(empty)'}`,
      );
    } catch (err) {
      logger.warn(
        { err: (err as Error).message, file_id: f.id, mimetype: f.mimetype },
        'slack_audio_transcribe_failed',
      );
      transcripts.push(
        `[voice message ${f.name} — transcription failed: ${(err as Error).message}]`,
      );
    }
  }

  if (images.length === 0) {
    const merged = [userText, ...transcripts].filter(Boolean).join('\n\n');
    return { role: 'user', content: merged };
  }

  const parts: UserContentPart[] = [];
  const textPart = [userText, ...transcripts].filter(Boolean).join('\n\n');
  if (textPart.length > 0) parts.push({ type: 'text', text: textPart });
  for (const f of images) {
    try {
      const dataUrl = await slackImageToDataUrl(f.url_private, f.mimetype);
      parts.push({ type: 'image_url', image_url: { url: dataUrl } });
    } catch (err) {
      logger.warn(
        { err: (err as Error).message, file_id: f.id, mimetype: f.mimetype },
        'slack_image_inline_failed',
      );
      parts.push({
        type: 'text',
        text: `[attached image ${f.name} (${f.mimetype}) — failed to load: ${(err as Error).message}]`,
      });
    }
  }
  if (parts.length === 0) {
    return { role: 'user', content: userText };
  }
  return { role: 'user', content: parts };
}

export interface ToolLoopResult {
  text: string;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  latency_ms: number;
  llm_calls: number;
  tool_calls: number;
  halt_reason: 'final_text' | 'no_choice' | 'max_iterations';
  tool_executions: ToolExecRecord[];
}

const MAX_ITERATIONS = 50;
const EXCERPT_CHARS = 2_000;

export async function runToolLoop(opts: RunOpts): Promise<ToolLoopResult> {
  const { redis, ctx, systemPrompt, contextBlocks, userText, userFiles, onProgress } = opts;
  const started = Date.now();

  const visibleTools = listForContext(ctx);
  const definitions =
    visibleTools.length > 0 ? toolDefinitionsForLLM(visibleTools) : undefined;

  const messages: ChatMessage[] = [{ role: 'system', content: systemPrompt }];
  if (contextBlocks.length > 0) {
    messages.push({ role: 'system', content: contextBlocks.join('\n\n') });
  }
  messages.push(await buildUserMessage(userText, userFiles));

  let tokensIn = 0;
  let tokensOut = 0;
  let costUsd = 0;
  let llmCalls = 0;
  let toolCalls = 0;
  let finalText = '(no response)';
  let haltReason: ToolLoopResult['halt_reason'] = 'max_iterations';
  const toolExecutions: ToolExecRecord[] = [];

  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    llmCalls++;

    // Stream the completion. Progress callback fires for text deltas only;
    // tool-call iterations emit no content deltas so onProgress stays silent.
    const completion = await streamCompletion(
      {
        model: llmModel,
        messages,
        ...(definitions ? { tools: definitions, tool_choice: 'auto' as const } : {}),
      },
      onProgress,
    );

    tokensIn += completion.prompt_tokens;
    tokensOut += completion.completion_tokens;
    costUsd += computeCost(llmModel, completion.prompt_tokens, completion.completion_tokens);

    // Reconstruct an assistant message identical in shape to non-streamed flow
    const hasToolCalls = completion.tool_calls.length > 0;
    const assistantMsg: ChatMessage =
      hasToolCalls
        ? {
            role: 'assistant',
            content: completion.text || null,
            tool_calls: completion.tool_calls.map((t) => ({
              id: t.id,
              type: 'function' as const,
              function: { name: t.function.name, arguments: t.function.arguments },
            })),
          }
        : { role: 'assistant', content: completion.text };

    messages.push(assistantMsg);

    if (hasToolCalls) {
      const results = await Promise.all(
        completion.tool_calls.map(async (tc) => {
          toolCalls++;
          let args: unknown = {};
          try {
            args = JSON.parse(tc.function.arguments);
          } catch (err) {
            return {
              id: tc.id,
              content: `invalid JSON args: ${(err as Error).message}`,
              cost: 0,
            };
          }
          const result = await executeTool(redis, tc.function.name, args, ctx);
          toolExecutions.push({
            name: tc.function.name,
            args,
            result_excerpt: result.content.slice(0, EXCERPT_CHARS),
            status: result.status,
            latency_ms: result.meta.latency_ms,
            cost_usd: result.meta.cost_usd,
            cache_hit: result.meta.cache_hit,
          });
          logger.info(
            {
              turn_id: ctx.turn_id,
              tool: tc.function.name,
              status: result.status,
              latency_ms: result.meta.latency_ms,
              cache_hit: result.meta.cache_hit,
              cost_usd: result.meta.cost_usd,
            },
            'tool_call_done',
          );
          return { id: tc.id, content: result.content, cost: result.meta.cost_usd };
        }),
      );
      for (const r of results) {
        costUsd += r.cost;
        messages.push({
          role: 'tool',
          tool_call_id: r.id,
          content: r.content,
        });
      }
      continue;
    }

    finalText = completion.text || '(empty response)';
    haltReason = 'final_text';
    break;
  }

  return {
    text: finalText,
    tokens_in: tokensIn,
    tokens_out: tokensOut,
    cost_usd: costUsd,
    latency_ms: Date.now() - started,
    llm_calls: llmCalls,
    tool_calls: toolCalls,
    halt_reason: haltReason,
    tool_executions: toolExecutions,
  };
}
