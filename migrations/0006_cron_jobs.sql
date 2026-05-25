-- M8.10: scheduler tool — one-shot scheduled prompts that fire as if the user sent them.

CREATE TABLE cron_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id text NOT NULL,
  owner_channel_id text NOT NULL,
  fire_at timestamptz NOT NULL,
  action_prompt text NOT NULL,
  active boolean DEFAULT true,
  fired_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX cron_jobs_fire_at_idx ON cron_jobs (fire_at) WHERE active = true AND fired_at IS NULL;
CREATE INDEX cron_jobs_owner_idx ON cron_jobs (owner_user_id, fire_at);
