import { describe, expect, it } from 'vitest';
import { packMemory } from '../../src/memory/packer.js';
import type { UserProfile } from '../../src/memory/profile.js';
import type { RecentTurn } from '../../src/memory/recent.js';

const profile: UserProfile = {
  slack_user_id: 'U001',
  name: 'Alice',
  tz: 'America/New_York',
  region: null,
  role: null,
  prefs: {},
};

function turn(role: string, content: string): RecentTurn {
  return { role, content, ts: new Date(0), user_id: 'U001' };
}

describe('packMemory', () => {
  it('returns empty blocks for empty input', () => {
    const r = packMemory({ recent_turns: [] });
    expect(r.blocks).toEqual([]);
    expect(r.total_tokens).toBe(0);
  });

  it('includes user_profile when present', () => {
    const r = packMemory({ recent_turns: [], user_profile: profile });
    expect(r.blocks.length).toBe(1);
    expect(r.blocks[0]).toContain('<user_profile>');
    expect(r.blocks[0]).toContain('Alice');
    expect(r.trace.user_profile).toBeGreaterThan(0);
  });

  it('packs in priority order: profile, recent, skills, facts, episodic, summary', () => {
    const r = packMemory({
      user_profile: profile,
      recent_turns: [turn('user', 'hi')],
      thread_summary: 'old chatter',
      facts: [
        { subject: 'Alice', predicate: 'likes', object: 'coffee', confidence: 0.9, sim: 0.8 },
      ],
      episodic_recall: [
        { chunk_content: 'remembered chunk', message_role: 'user', sim: 0.7 },
      ],
      skills: [{ name: 'do_x', trigger_desc: 'when x happens', steps: [], sim: 0.6 }],
    });
    const order = r.blocks.map((b) => {
      if (b.includes('<user_profile>')) return 'profile';
      if (b.includes('<recent_turns>')) return 'recent';
      if (b.includes('<candidate_skills>')) return 'skills';
      if (b.includes('<facts>')) return 'facts';
      if (b.includes('<episodic_recall>')) return 'episodic';
      if (b.includes('<thread_summary>')) return 'summary';
      return 'unknown';
    });
    expect(order).toEqual(['profile', 'recent', 'skills', 'facts', 'episodic', 'summary']);
  });

  it('drops lower-priority blocks that exceed budget', () => {
    const huge = 'x'.repeat(40_000); // ~10k tokens estimate
    const r = packMemory(
      {
        user_profile: profile,
        recent_turns: [turn('user', huge)],
        thread_summary: 'should be dropped due to budget',
      },
      500, // tiny budget
    );
    // profile fits; recent_turns is huge; summary is also tiny enough; but budget allows tiny only
    expect(r.trace.recent_turns).toBe(0);
    expect(r.total_tokens).toBeLessThanOrEqual(500);
  });

  it('strips no dupes between sections currently (sections are unique strings)', () => {
    const r = packMemory({
      recent_turns: [turn('user', 'hello'), turn('assistant', 'world')],
    });
    expect(r.blocks).toHaveLength(1);
    expect(r.blocks[0]).toMatch(/user: hello[\s\S]*assistant: world/);
  });
});
