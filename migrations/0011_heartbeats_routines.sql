-- M11: proactive heartbeat + approval-gated autopilot routines.

CREATE TABLE heartbeats (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL,
  dm_channel_id text,
  cadence varchar(16) NOT NULL,            -- 'daily' | 'weekly' | 'hourly'
  scan_prompt text NOT NULL,               -- what to look for
  enabled boolean NOT NULL DEFAULT true,
  last_run_at timestamptz,
  next_run_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX heartbeats_next_run_idx ON heartbeats (next_run_at) WHERE enabled = true;
CREATE INDEX heartbeats_user_idx ON heartbeats (user_id);

CREATE TABLE routines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL,
  channel_id text NOT NULL,
  name text NOT NULL,
  description text,
  trigger_kind varchar(16) NOT NULL,        -- 'cron' | 'manual'
  trigger_spec jsonb NOT NULL,              -- e.g. {"cron":"0 9 * * 1"} or {}
  plan_prompt text NOT NULL,                -- the action prompt run as a turn
  tool_set_hash text NOT NULL,              -- snapshot of allowed-tools list at approval
  status varchar(16) NOT NULL DEFAULT 'pending',  -- pending | approved | paused | revoked
  approved_at timestamptz,
  approved_by text,
  last_run_at timestamptz,
  last_run_status varchar(16),
  consecutive_failures integer NOT NULL DEFAULT 0,
  next_run_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX routines_status_idx ON routines (status, trigger_kind);
CREATE INDEX routines_next_run_idx ON routines (next_run_at) WHERE status = 'approved';
CREATE INDEX routines_user_idx ON routines (user_id);
