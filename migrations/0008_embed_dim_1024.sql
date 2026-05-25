-- Switch embedding dimension from 1536 (OpenAI text-embedding-3-small) to 1024
-- (mistral-embed, voyage-3, bge-m3, etc.). Existing embedding data is destroyed
-- — it cannot be coerced across dimensions. Tables that have stored vectors
-- need re-embedding (happens lazily on next memory write per row).

-- message_chunks
DROP INDEX IF EXISTS message_chunks_embedding_hnsw_idx;
ALTER TABLE message_chunks DROP COLUMN IF EXISTS embedding;
ALTER TABLE message_chunks ADD COLUMN embedding vector(1024);
CREATE INDEX message_chunks_embedding_hnsw_idx
  ON message_chunks USING hnsw (embedding vector_cosine_ops);

-- facts
DROP INDEX IF EXISTS facts_embedding_hnsw_idx;
ALTER TABLE facts DROP COLUMN IF EXISTS embedding;
ALTER TABLE facts ADD COLUMN embedding vector(1024);
CREATE INDEX facts_embedding_hnsw_idx
  ON facts USING hnsw (embedding vector_cosine_ops);

-- skills
DROP INDEX IF EXISTS skills_embedding_hnsw_idx;
ALTER TABLE skills DROP COLUMN IF EXISTS embedding;
ALTER TABLE skills ADD COLUMN embedding vector(1024);
CREATE INDEX skills_embedding_hnsw_idx
  ON skills USING hnsw (embedding vector_cosine_ops);

-- scraped_pages
DROP INDEX IF EXISTS scraped_pages_embedding_hnsw_idx;
ALTER TABLE scraped_pages DROP COLUMN IF EXISTS embedding;
ALTER TABLE scraped_pages ADD COLUMN embedding vector(1024);
CREATE INDEX scraped_pages_embedding_hnsw_idx
  ON scraped_pages USING hnsw (embedding vector_cosine_ops);
