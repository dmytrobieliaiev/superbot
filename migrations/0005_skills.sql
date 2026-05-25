-- M10.1: skills table — procedural memory mined from successful complex trajectories.

CREATE TABLE skills (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  trigger_desc text NOT NULL,
  steps jsonb NOT NULL,
  params_schema jsonb,
  version integer DEFAULT 1,
  success_count integer DEFAULT 0,
  fail_count integer DEFAULT 0,
  last_used_at timestamptz,
  active boolean DEFAULT true,
  embedding vector(1536),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX skills_active_idx ON skills (active, last_used_at);
CREATE INDEX skills_embedding_hnsw_idx ON skills USING hnsw (embedding vector_cosine_ops);
