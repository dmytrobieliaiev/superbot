-- Idempotency table: tracks whether a turn (Slack event) has been replied to.
-- Prevents duplicate Slack replies when BullMQ retries a job that already posted.

CREATE TABLE turn_state (
  event_id text PRIMARY KEY,
  turn_id uuid NOT NULL,
  status varchar(16) NOT NULL,
  replied_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX turn_state_status_idx ON turn_state (status, created_at);
