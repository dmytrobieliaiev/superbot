import { readFileSync } from 'node:fs';
import { parse as yamlParse } from 'yaml';
import { z } from 'zod';

const AclSchema = z.object({
  channels: z.object({
    allow: z.array(z.string()).default(['*']),
    deny: z.array(z.string()).default([]),
  }),
  users: z.object({
    deny: z.array(z.string()).default([]),
  }),
  event_kinds: z.object({
    enabled: z
      .array(z.enum(['mention', 'dm', 'shortcut', 'command', 'interactive', 'reaction']))
      .default(['mention', 'dm', 'shortcut', 'command', 'interactive']),
  }),
});

export type Acl = z.infer<typeof AclSchema>;

export function loadAcl(path = 'config/acl.yaml'): Acl {
  const raw = readFileSync(path, 'utf-8');
  return AclSchema.parse(yamlParse(raw));
}
