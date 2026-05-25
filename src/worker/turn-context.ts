// Read-path fanout for a turn: load profile + recent turns + thread summary
// + embedding-based facts/episodic/skill recall, then pack into context blocks.

import { isMemoryEnabled } from '../db/index.js';
import { embedOne } from '../llm/embed.js';
import { searchFactsByEmbedding } from '../memory/facts.js';
import { packMemory, type PackedContext } from '../memory/packer.js';
import { getUserProfile, type UserProfile } from '../memory/profile.js';
import { searchEpisodicByEmbedding } from '../memory/recall.js';
import { getRecentTurns, type RecentTurn } from '../memory/recent.js';
import { searchSkillsByEmbedding } from '../memory/skills.js';
import { getThreadSummary } from '../memory/summary.js';
import type { EnrichedEvent, ThreadMessage } from '../slack/types.js';

function backlogAsRecentTurns(evt: EnrichedEvent): RecentTurn[] {
  return (evt.thread_backlog ?? []).map((m: ThreadMessage) => ({
    role: 'user',
    content: m.text,
    ts: new Date(Number(m.ts) * 1000),
    user_id: m.user,
  }));
}

export interface TurnContext {
  packed: PackedContext;
  profile: UserProfile | undefined;
  recentTurns: RecentTurn[];
  effectiveThreadTs: string;
}

/**
 * Load all read-path memory for a turn. `effectiveThreadTs` is the resolved
 * thread root used for both reads and writes — see processTurn for rationale.
 */
export async function loadTurnContext(
  evt: EnrichedEvent,
  userText: string,
): Promise<TurnContext> {
  const memoryOn = isMemoryEnabled();
  const effectiveThreadTs = evt.thread_ts ?? evt.ts;

  const queryVecPromise: Promise<number[] | null> = memoryOn
    ? embedOne(userText).catch(() => null)
    : Promise.resolve(null);

  const [profile, recentTurns, threadSummary, queryVec] = memoryOn
    ? await Promise.all([
        getUserProfile(evt.user_id).catch(() => undefined),
        getRecentTurns(evt.channel_id, effectiveThreadTs, 10).catch(() => [] as RecentTurn[]),
        getThreadSummary(effectiveThreadTs).catch(() => undefined),
        queryVecPromise,
      ])
    : [undefined, backlogAsRecentTurns(evt), undefined, null];

  const [factsHits, episodicHits, skillsHits] =
    memoryOn && queryVec
      ? await Promise.all([
          searchFactsByEmbedding(queryVec, 'user', evt.user_id, 8).catch(() => []),
          searchEpisodicByEmbedding(queryVec, evt.user_id, 5).catch(() => []),
          searchSkillsByEmbedding(queryVec, 3).catch(() => []),
        ])
      : [[], [], []];

  const packed = packMemory({
    user_profile: profile,
    recent_turns: recentTurns,
    thread_summary: threadSummary,
    facts: factsHits,
    episodic_recall: episodicHits,
    skills: skillsHits,
  });

  return { packed, profile, recentTurns, effectiveThreadTs };
}
