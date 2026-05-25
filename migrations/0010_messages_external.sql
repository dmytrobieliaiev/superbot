-- M10: backfilled Slack history support.
-- - external_ts: Slack message ts (string) for dedup across re-runs.
-- - source:     'live' (default, from event handler) or 'backfill'.

ALTER TABLE messages
  ADD COLUMN external_ts text,
  ADD COLUMN source varchar(16) NOT NULL DEFAULT 'live';

-- Dedup: one row per (channel, slack_ts) when external_ts populated.
CREATE UNIQUE INDEX messages_channel_external_ts_uidx
  ON messages (channel_id, external_ts)
  WHERE external_ts IS NOT NULL;

CREATE INDEX messages_source_idx ON messages (source);
