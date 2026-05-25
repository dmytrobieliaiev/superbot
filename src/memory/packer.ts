import type { FactSearchResult } from './facts.js';
import type { RecentTurn } from './recent.js';
import type { UserProfile } from './profile.js';
import type { SkillSearchHit } from './skills.js';

export interface PackInput {
  user_profile?: UserProfile | undefined;
  recent_turns: RecentTurn[];
  thread_summary?: string | undefined;
  facts?: FactSearchResult[];
  episodic_recall?: Array<{ chunk_content: string; message_role: string; sim: number }>;
  skills?: SkillSearchHit[];
}

export interface PackedContext {
  blocks: string[];
  trace: Record<string, number>;
  total_tokens: number;
  remaining_tokens: number;
}

const CHARS_PER_TOKEN = 4; // English approximation

function estimateTokens(s: string): number {
  return Math.ceil(s.length / CHARS_PER_TOKEN);
}

function profileBlock(p: UserProfile): string {
  const lines = [`slack_user_id: ${p.slack_user_id}`];
  if (p.name) lines.push(`name: ${p.name}`);
  if (p.tz) lines.push(`tz: ${p.tz}`);
  if (p.region) lines.push(`region: ${p.region}`);
  if (p.role) lines.push(`role: ${p.role}`);
  return `<user_profile>\n${lines.join('\n')}\n</user_profile>`;
}

function recentBlock(turns: RecentTurn[]): string {
  const formatted = turns.map((t) => `${t.role}: ${t.content}`).join('\n');
  return `<recent_turns>\n${formatted}\n</recent_turns>`;
}

/**
 * Priority-ordered, budget-aware memory packer. Sections requested in
 * priority order; each takes as much budget as it fits; lower-priority
 * sections may be skipped if budget exhausted.
 */
export function packMemory(input: PackInput, budgetTokens = 8000): PackedContext {
  const blocks: string[] = [];
  const trace: Record<string, number> = {};
  let remaining = budgetTokens;

  const add = (section: string, content: string): void => {
    const cost = estimateTokens(content);
    if (cost > remaining) {
      trace[section] = 0;
      return;
    }
    blocks.push(content);
    trace[section] = cost;
    remaining -= cost;
  };

  // 1. user_profile (cheap, always include)
  if (input.user_profile) add('user_profile', profileBlock(input.user_profile));

  // 2. recent_turns (almost always include)
  if (input.recent_turns.length > 0) add('recent_turns', recentBlock(input.recent_turns));

  // 3. candidate_skills (M10)
  if (input.skills && input.skills.length > 0) {
    const formatted = input.skills
      .map((s) => `- ${s.name}: ${s.trigger_desc} (sim=${s.sim.toFixed(2)})`)
      .join('\n');
    add('skills', `<candidate_skills>\n${formatted}\n</candidate_skills>`);
  }

  // 4. semantic_facts (M6)
  if (input.facts && input.facts.length > 0) {
    const formatted = input.facts
      .map((f) => `- ${f.subject} | ${f.predicate} | ${f.object} (conf=${f.confidence.toFixed(2)})`)
      .join('\n');
    add('facts', `<facts>\n${formatted}\n</facts>`);
  }

  // 5. episodic_recall (M6)
  if (input.episodic_recall && input.episodic_recall.length > 0) {
    const formatted = input.episodic_recall
      .map((e) => `(${e.message_role}, sim=${e.sim.toFixed(2)}): ${e.chunk_content}`)
      .join('\n---\n');
    add('episodic_recall', `<episodic_recall>\n${formatted}\n</episodic_recall>`);
  }

  // 6. thread_summary (lowest priority, fills in older context)
  if (input.thread_summary) {
    add('thread_summary', `<thread_summary>\n${input.thread_summary}\n</thread_summary>`);
  }

  return {
    blocks,
    trace,
    total_tokens: budgetTokens - remaining,
    remaining_tokens: remaining,
  };
}
