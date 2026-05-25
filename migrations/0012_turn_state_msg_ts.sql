-- M12: track bot reply msg_ts so reaction handlers can look up the originating turn.

ALTER TABLE turn_state
  ADD COLUMN bot_msg_ts text,
  ADD COLUMN channel_id text;

CREATE INDEX turn_state_msg_ts_idx
  ON turn_state (channel_id, bot_msg_ts)
  WHERE bot_msg_ts IS NOT NULL;
