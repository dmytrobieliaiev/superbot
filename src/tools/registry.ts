import { checkToolAcl } from '../config/tool-acl.js';
import type { ToolContext, ToolSpec } from './types.js';

const reg = new Map<string, ToolSpec>();

export function register(spec: ToolSpec): void {
  reg.set(spec.name, spec);
}

export function get(name: string): ToolSpec | undefined {
  return reg.get(name);
}

export function listAll(): ToolSpec[] {
  return [...reg.values()];
}

export function listForContext(ctx: ToolContext): ToolSpec[] {
  return listAll().filter((t) => {
    if (t.acl && !t.acl(ctx)) return false;
    if (!checkToolAcl(t.name, ctx.channel_id, ctx.user_id)) return false;
    return true;
  });
}

export interface LLMToolDef {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export function toolDefinitionsForLLM(tools: ToolSpec[]): LLMToolDef[] {
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.params_schema as Record<string, unknown>,
    },
  }));
}
