-- Initial schema for M3 (memory) + M10 (audit_log skeleton)
-- Adds pgvector extension + core tables.

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Read-only role for M8.6 db_query tool (analytics schema access added later)
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'agent_ro') THEN
    CREATE ROLE agent_ro NOLOGIN;
  END IF;
END
$$;

CREATE TABLE messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  turn_id uuid,
  channel_id text NOT NULL,
  user_id text NOT NULL,
  thread_ts text,
  role varchar(16) NOT NULL,
  content text NOT NULL,
  tool_calls jsonb,
  tool_results jsonb,
  tokens integer DEFAULT 0,
  cost_usd real DEFAULT 0,
  latency_ms integer,
  ts timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX messages_thread_ts_ts_idx ON messages (thread_ts, ts);
CREATE INDEX messages_channel_id_ts_idx ON messages (channel_id, ts);
CREATE INDEX messages_user_id_ts_idx ON messages (user_id, ts);
CREATE INDEX messages_turn_id_idx ON messages (turn_id);

CREATE TABLE message_chunks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  chunk_index integer NOT NULL,
  content text NOT NULL,
  embedding vector(1536),
  ts timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX message_chunks_message_id_idx ON message_chunks (message_id);
CREATE INDEX message_chunks_embedding_hnsw_idx ON message_chunks
  USING hnsw (embedding vector_cosine_ops);

CREATE TABLE thread_summary (
  thread_ts text PRIMARY KEY,
  channel_id text NOT NULL,
  summary text NOT NULL,
  last_msg_ts text,
  turn_count integer DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE user_profile (
  slack_user_id text PRIMARY KEY,
  name text,
  tz text,
  region text,
  role text,
  prefs jsonb DEFAULT '{}'::jsonb,
  oauth_tokens jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ts timestamptz NOT NULL DEFAULT now(),
  actor varchar(16) NOT NULL,
  action text NOT NULL,
  payload jsonb DEFAULT '{}'::jsonb,
  parent_hash text,
  self_hash text NOT NULL
);

CREATE INDEX audit_log_ts_idx ON audit_log (ts);
