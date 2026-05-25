-- M9: pinned (core) memories — exempt from confidence decay / 60-day soft-delete.

ALTER TABLE facts
  ADD COLUMN pinned boolean NOT NULL DEFAULT false;

CREATE INDEX facts_pinned_idx ON facts (pinned) WHERE pinned = true;

-- Backfill: existing rows inserted via rememberPinned() used predicate='pinned'
-- and confidence=1.0 as a soft signal. Promote those to the real flag.
UPDATE facts
SET pinned = true
WHERE predicate = 'pinned'
  AND confidence >= 1.0
  AND contradicted = false;
