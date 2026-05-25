import { eq } from 'drizzle-orm';
import { getDb, isMemoryEnabled } from '../db/index.js';
import { user_profile } from '../db/schema.js';
import type { EnrichedEvent } from '../slack/types.js';

export interface UserProfile {
  slack_user_id: string;
  name: string | null;
  tz: string | null;
  region: string | null;
  role: string | null;
  prefs: unknown;
}

export async function getUserProfile(slack_user_id: string): Promise<UserProfile | undefined> {
  if (!isMemoryEnabled()) return undefined;
  const db = getDb();
  const rows = await db
    .select()
    .from(user_profile)
    .where(eq(user_profile.slack_user_id, slack_user_id))
    .limit(1);
  const row = rows[0];
  if (!row) return undefined;
  return {
    slack_user_id: row.slack_user_id,
    name: row.name,
    tz: row.tz,
    region: row.region,
    role: row.role,
    prefs: row.prefs,
  };
}

/**
 * Upsert user_profile from Slack enrichment. Only touches fields that
 * are populated in the event so manual edits aren't clobbered.
 */
export async function syncUserProfile(evt: EnrichedEvent): Promise<void> {
  if (!isMemoryEnabled()) return;
  if (!evt.user_info) return;
  const db = getDb();
  const updateFields: Partial<{ name: string; tz: string; updated_at: Date }> = {
    updated_at: new Date(),
  };
  if (evt.user_info.name) updateFields.name = evt.user_info.name;
  if (evt.user_info.tz) updateFields.tz = evt.user_info.tz;

  await db
    .insert(user_profile)
    .values({
      slack_user_id: evt.user_id,
      name: evt.user_info.name ?? null,
      tz: evt.user_info.tz ?? null,
    })
    .onConflictDoUpdate({
      target: user_profile.slack_user_id,
      set: updateFields,
    });
}
