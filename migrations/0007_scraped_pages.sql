-- M9.5: web/scrape cache for scraped page content (router-fed).

CREATE TABLE scraped_pages (
  url_hash text PRIMARY KEY,
  url text NOT NULL,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  content_md text NOT NULL,
  title text,
  source_tool varchar(32) NOT NULL,
  embedding vector(1536)
);

CREATE INDEX scraped_pages_fetched_at_idx ON scraped_pages (fetched_at);
CREATE INDEX scraped_pages_embedding_hnsw_idx ON scraped_pages USING hnsw (embedding vector_cosine_ops);
