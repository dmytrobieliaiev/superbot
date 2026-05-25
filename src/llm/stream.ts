import type OpenAI from 'openai';
import { llm } from './client.js';

type ChatParams = OpenAI.Chat.Completions.ChatCompletionCreateParams;

export interface StreamedToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface StreamedCompletion {
  text: string;
  tool_calls: StreamedToolCall[];
  prompt_tokens: number;
  completion_tokens: number;
  finish_reason: string | null;
}

export type ProgressCallback = (delta: string, accumulated: string) => void;

interface ToolCallAccumulator {
  id: string;
  name: string;
  arguments: string;
}

/**
 * Streaming wrapper around chat.completions. Reassembles tool_calls from deltas
 * and surfaces text deltas via onProgress as they arrive. Returns a final
 * snapshot identical in shape to the non-streamed message.
 */
export async function streamCompletion(
  params: Omit<ChatParams, 'stream'>,
  onProgress?: ProgressCallback,
): Promise<StreamedCompletion> {
  const stream = await llm.chat.completions.create({
    ...params,
    stream: true,
    stream_options: { include_usage: true },
  });

  let text = '';
  const byIndex = new Map<number, ToolCallAccumulator>();
  let promptTokens = 0;
  let completionTokens = 0;
  let finishReason: string | null = null;

  for await (const chunk of stream) {
    if (chunk.usage) {
      promptTokens = chunk.usage.prompt_tokens ?? promptTokens;
      completionTokens = chunk.usage.completion_tokens ?? completionTokens;
    }
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    const delta = choice.delta;
    if (!delta) continue;

    if (typeof delta.content === 'string' && delta.content.length > 0) {
      text += delta.content;
      onProgress?.(delta.content, text);
    }

    if (delta.tool_calls) {
      for (const tcDelta of delta.tool_calls) {
        const idx = tcDelta.index;
        let acc = byIndex.get(idx);
        if (!acc) {
          acc = { id: '', name: '', arguments: '' };
          byIndex.set(idx, acc);
        }
        if (tcDelta.id) acc.id = tcDelta.id;
        if (tcDelta.function?.name) acc.name = tcDelta.function.name;
        if (typeof tcDelta.function?.arguments === 'string') {
          acc.arguments += tcDelta.function.arguments;
        }
      }
    }
  }

  const tool_calls: StreamedToolCall[] = [...byIndex.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, t]) => ({
      id: t.id,
      type: 'function' as const,
      function: { name: t.name, arguments: t.arguments },
    }));

  return {
    text,
    tool_calls,
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    finish_reason: finishReason,
  };
}
