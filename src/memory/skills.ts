import { desc, eq } from 'drizzle-orm';
import { getDb, getRawClient, isMemoryEnabled } from '../db/index.js';
import { skills } from '../db/schema.js';
import { llm, llmModel } from '../llm/client.js';
import { embedOne } from '../llm/embed.js';
import { logger } from '../logger.js';

const MIN_TOOL_CALLS_FOR_MINING = 3;

const MINER_PROMPT = `Given this conversation trajectory, decide whether it represents a reusable skill.

Output a skill ONLY if:
- The trajectory involved multiple tool calls in a non-trivial workflow
- The workflow would generalize to similar future requests
- It is meaningfully more useful than a single tool call

Schema for an emitted skill:
- name: short snake_case verb_phrase (e.g. "summarize_pdf", "research_topic")
- trigger_desc: when to invoke (1 sentence)
- steps: array of brief step descriptions in order
- params_schema: JSON Schema object describing inputs the skill needs

If not generalizable, return { "skill": null }.

Return JSON: { "skill": ... | null }`;

export interface MinedSkill {
  name: string;
  trigger_desc: string;
  steps: unknown[];
  params_schema: Record<string, unknown>;
}

export async function mineSkillFromTrajectory(opts: {
  user_text: string;
  assistant_text: string;
  tool_executions: Array<{ name: string; args: unknown }>;
}): Promise<MinedSkill | null> {
  if (opts.tool_executions.length < MIN_TOOL_CALLS_FOR_MINING) return null;
  try {
    const toolList = opts.tool_executions.map((t) => t.name).join(', ');
    const transcript = `User asked: ${opts.user_text}\n\nAssistant responded: ${opts.assistant_text}\n\nTools called (in order): ${toolList}`;
    const resp = await llm.chat.completions.create({
      model: llmModel,
      messages: [
        { role: 'system', content: MINER_PROMPT },
        { role: 'user', content: transcript },
      ],
      response_format: { type: 'json_object' },
    });
    const text = resp.choices[0]?.message?.content ?? '{}';
    const parsed = JSON.parse(text) as { skill?: MinedSkill | null };
    if (!parsed.skill || !parsed.skill.name) return null;
    return parsed.skill;
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'skill_miner_failed');
    return null;
  }
}

export async function storeSkill(skill: MinedSkill): Promise<void> {
  if (!isMemoryEnabled()) return;
  const db = getDb();
  const embedding = await embedOne(`${skill.name} ${skill.trigger_desc}`);
  await db.insert(skills).values({
    name: skill.name,
    trigger_desc: skill.trigger_desc,
    steps: skill.steps,
    params_schema: skill.params_schema,
    embedding,
  });
}

export interface SkillSearchHit {
  name: string;
  trigger_desc: string;
  steps: unknown;
  sim: number;
}

export async function searchSkillsByEmbedding(
  queryVec: number[],
  limit = 3,
): Promise<SkillSearchHit[]> {
  if (!isMemoryEnabled()) return [];
  const sql = getRawClient();
  const literal = `[${queryVec.join(',')}]`;
  const rows = await sql<SkillSearchHit[]>`
    SELECT name, trigger_desc, steps, 1 - (embedding <=> ${literal}::vector) AS sim
    FROM skills
    WHERE active = true
    ORDER BY embedding <=> ${literal}::vector
    LIMIT ${limit}
  `;
  return rows.filter((r) => r.sim > 0.4);
}

export interface SkillListItem {
  id: string;
  name: string;
  trigger_desc: string;
  success_count: number | null;
  fail_count: number | null;
  last_used_at: Date | null;
}

export async function listSkills(): Promise<SkillListItem[]> {
  if (!isMemoryEnabled()) return [];
  const db = getDb();
  return db
    .select({
      id: skills.id,
      name: skills.name,
      trigger_desc: skills.trigger_desc,
      success_count: skills.success_count,
      fail_count: skills.fail_count,
      last_used_at: skills.last_used_at,
    })
    .from(skills)
    .where(eq(skills.active, true))
    .orderBy(desc(skills.last_used_at));
}

export async function deleteSkill(skill_id: string): Promise<boolean> {
  if (!isMemoryEnabled()) return false;
  const db = getDb();
  const result = await db
    .update(skills)
    .set({ active: false })
    .where(eq(skills.id, skill_id))
    .returning({ id: skills.id });
  return result.length > 0;
}
