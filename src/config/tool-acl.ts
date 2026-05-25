import { existsSync, readFileSync } from 'node:fs';
import { parse as yamlParse } from 'yaml';
import { z } from 'zod';
import { logger } from '../logger.js';

const ToolAclSchema = z.object({
  defaults: z
    .object({
      deny: z.boolean().default(false),
    })
    .default({ deny: false }),
  tools: z
    .record(
      z.object({
        channels: z.array(z.string()).default(['*']),
        users: z.array(z.string()).default(['*']),
        roles: z.array(z.string()).optional(),
      }),
    )
    .default({}),
});

export type ToolAcl = z.infer<typeof ToolAclSchema>;

let cache: ToolAcl | null = null;

export function loadToolAcl(path = 'config/tool-acl.yaml'): ToolAcl {
  if (cache) return cache;
  try {
    if (!existsSync(path)) {
      cache = { defaults: { deny: false }, tools: {} };
      return cache;
    }
    const raw = readFileSync(path, 'utf-8');
    cache = ToolAclSchema.parse(yamlParse(raw));
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, path },
      'tool ACL parse failed — defaulting to permissive',
    );
    cache = { defaults: { deny: false }, tools: {} };
  }
  return cache;
}

export function checkToolAcl(
  toolName: string,
  channel_id: string,
  user_id: string,
): boolean {
  const acl = loadToolAcl();
  const entry = acl.tools[toolName];
  if (!entry) return !acl.defaults.deny;
  const chanOk = entry.channels.includes('*') || entry.channels.includes(channel_id);
  const userOk = entry.users.includes('*') || entry.users.includes(user_id);
  return chanOk && userOk;
}
