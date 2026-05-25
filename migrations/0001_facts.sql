-- M6: semantic memory — facts table with embedding + scope.

CREATE TABLE facts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject text NOT NULL,
  predicate text NOT NULL,
  object text NOT NULL,
  confidence real NOT NULL DEFAULT 0.7,
  source_turn_id uuid,
  scope varchar(16) NOT NULL DEFAULT 'user',
  scope_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  contradicted boolean DEFAULT false,
  embedding vector(1536)
);

CREATE INDEX facts_scope_idx ON facts (scope, scope_id);
CREATE INDEX facts_subject_idx ON facts (subject);
CREATE INDEX facts_last_seen_idx ON facts (last_seen_at);
CREATE INDEX facts_embedding_hnsw_idx ON facts USING hnsw (embedding vector_cosine_ops);
