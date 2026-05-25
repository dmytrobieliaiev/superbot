-- M7.3-4: eval harness — curated test set + nightly regression run.

CREATE TABLE eval_set (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trajectory_id uuid NOT NULL REFERENCES trajectories(turn_id) ON DELETE CASCADE,
  user_input text NOT NULL,
  expected_outcome varchar(16) NOT NULL,
  rubric_notes text,
  approved_by text NOT NULL,
  approved_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX eval_set_approved_at_idx ON eval_set (approved_at);

CREATE TABLE eval_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  eval_set_id uuid NOT NULL REFERENCES eval_set(id) ON DELETE CASCADE,
  ran_at timestamptz NOT NULL DEFAULT now(),
  helpful integer,
  correct integer,
  grounded integer,
  avg_score real,
  judge_note text,
  replay_text text,
  replay_outcome varchar(16),
  prompt_version text
);

CREATE INDEX eval_runs_ran_at_idx ON eval_runs (ran_at);
CREATE INDEX eval_runs_eval_set_id_idx ON eval_runs (eval_set_id);
