-- M7.1: per-turn trajectory logging. Full LLM + tool log for eval and (later) training.

CREATE TABLE trajectories (
  turn_id uuid PRIMARY KEY,
  event_id text NOT NULL,
  user_id text NOT NULL,
  channel_id text NOT NULL,
  thread_ts text,
  full_log jsonb NOT NULL,
  outcome varchar(16) NOT NULL,
  feedback jsonb,
  tokens_in integer DEFAULT 0,
  tokens_out integer DEFAULT 0,
  cost_usd real DEFAULT 0,
  latency_ms integer,
  llm_calls integer DEFAULT 0,
  tool_calls integer DEFAULT 0,
  halt_reason varchar(32),
  exported_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX trajectories_user_id_idx ON trajectories (user_id, created_at);
CREATE INDEX trajectories_outcome_idx ON trajectories (outcome, created_at);
CREATE INDEX trajectories_channel_id_idx ON trajectories (channel_id, created_at);
CREATE INDEX trajectories_created_at_idx ON trajectories (created_at);
CREATE INDEX trajectories_exported_at_idx ON trajectories (exported_at);
