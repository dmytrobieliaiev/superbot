import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  uuid,
  varchar,
  vector,
} from 'drizzle-orm/pg-core';

export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    turn_id: uuid('turn_id'),
    channel_id: text('channel_id').notNull(),
    user_id: text('user_id').notNull(),
    thread_ts: text('thread_ts'),
    role: varchar('role', { length: 16 }).notNull(),
    content: text('content').notNull(),
    tool_calls: jsonb('tool_calls'),
    tool_results: jsonb('tool_results'),
    tokens: integer('tokens').default(0),
    cost_usd: real('cost_usd').default(0),
    latency_ms: integer('latency_ms'),
    ts: timestamp('ts', { withTimezone: true }).defaultNow().notNull(),
    external_ts: text('external_ts'),
    source: varchar('source', { length: 16 }).notNull().default('live'),
  },
  (t) => [
    index('messages_thread_ts_ts_idx').on(t.thread_ts, t.ts),
    index('messages_channel_id_ts_idx').on(t.channel_id, t.ts),
    index('messages_user_id_ts_idx').on(t.user_id, t.ts),
    index('messages_turn_id_idx').on(t.turn_id),
    index('messages_source_idx').on(t.source),
  ],
);

export const message_chunks = pgTable(
  'message_chunks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    message_id: uuid('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    chunk_index: integer('chunk_index').notNull(),
    content: text('content').notNull(),
    embedding: vector('embedding', { dimensions: 1024 }),
    ts: timestamp('ts', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('message_chunks_message_id_idx').on(t.message_id),
    index('message_chunks_embedding_hnsw_idx')
      .using('hnsw', t.embedding.op('vector_cosine_ops')),
  ],
);

export const thread_summary = pgTable('thread_summary', {
  thread_ts: text('thread_ts').primaryKey(),
  channel_id: text('channel_id').notNull(),
  summary: text('summary').notNull(),
  last_msg_ts: text('last_msg_ts'),
  turn_count: integer('turn_count').default(0),
  updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export const user_profile = pgTable('user_profile', {
  slack_user_id: text('slack_user_id').primaryKey(),
  name: text('name'),
  tz: text('tz'),
  region: text('region'),
  role: text('role'),
  prefs: jsonb('prefs').default({}),
  oauth_tokens: jsonb('oauth_tokens'),
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export const audit_log = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ts: timestamp('ts', { withTimezone: true }).defaultNow().notNull(),
    actor: varchar('actor', { length: 16 }).notNull(),
    action: text('action').notNull(),
    payload: jsonb('payload').default({}),
    parent_hash: text('parent_hash'),
    self_hash: text('self_hash').notNull(),
  },
  (t) => [index('audit_log_ts_idx').on(t.ts)],
);

export const trajectories = pgTable(
  'trajectories',
  {
    turn_id: uuid('turn_id').primaryKey(),
    event_id: text('event_id').notNull(),
    user_id: text('user_id').notNull(),
    channel_id: text('channel_id').notNull(),
    thread_ts: text('thread_ts'),
    full_log: jsonb('full_log').notNull(),
    outcome: varchar('outcome', { length: 16 }).notNull(),
    feedback: jsonb('feedback'),
    tokens_in: integer('tokens_in').default(0),
    tokens_out: integer('tokens_out').default(0),
    cost_usd: real('cost_usd').default(0),
    latency_ms: integer('latency_ms'),
    llm_calls: integer('llm_calls').default(0),
    tool_calls: integer('tool_calls').default(0),
    halt_reason: varchar('halt_reason', { length: 32 }),
    exported_at: timestamp('exported_at', { withTimezone: true }),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('trajectories_user_id_idx').on(t.user_id, t.created_at),
    index('trajectories_outcome_idx').on(t.outcome, t.created_at),
    index('trajectories_channel_id_idx').on(t.channel_id, t.created_at),
    index('trajectories_created_at_idx').on(t.created_at),
    index('trajectories_exported_at_idx').on(t.exported_at),
  ],
);

export const turn_state = pgTable(
  'turn_state',
  {
    event_id: text('event_id').primaryKey(),
    turn_id: uuid('turn_id').notNull(),
    status: varchar('status', { length: 16 }).notNull(),
    replied_at: timestamp('replied_at', { withTimezone: true }),
    bot_msg_ts: text('bot_msg_ts'),
    channel_id: text('channel_id'),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('turn_state_status_idx').on(t.status, t.created_at),
    index('turn_state_msg_ts_idx').on(t.channel_id, t.bot_msg_ts),
  ],
);

export const eval_set = pgTable(
  'eval_set',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    trajectory_id: uuid('trajectory_id')
      .notNull()
      .references(() => trajectories.turn_id, { onDelete: 'cascade' }),
    user_input: text('user_input').notNull(),
    expected_outcome: varchar('expected_outcome', { length: 16 }).notNull(),
    rubric_notes: text('rubric_notes'),
    approved_by: text('approved_by').notNull(),
    approved_at: timestamp('approved_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('eval_set_approved_at_idx').on(t.approved_at)],
);

export const eval_runs = pgTable(
  'eval_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    eval_set_id: uuid('eval_set_id')
      .notNull()
      .references(() => eval_set.id, { onDelete: 'cascade' }),
    ran_at: timestamp('ran_at', { withTimezone: true }).defaultNow().notNull(),
    helpful: integer('helpful'),
    correct: integer('correct'),
    grounded: integer('grounded'),
    avg_score: real('avg_score'),
    judge_note: text('judge_note'),
    replay_text: text('replay_text'),
    replay_outcome: varchar('replay_outcome', { length: 16 }),
    prompt_version: text('prompt_version'),
  },
  (t) => [
    index('eval_runs_ran_at_idx').on(t.ran_at),
    index('eval_runs_eval_set_id_idx').on(t.eval_set_id),
  ],
);

export const scraped_pages = pgTable(
  'scraped_pages',
  {
    url_hash: text('url_hash').primaryKey(),
    url: text('url').notNull(),
    fetched_at: timestamp('fetched_at', { withTimezone: true }).defaultNow().notNull(),
    content_md: text('content_md').notNull(),
    title: text('title'),
    source_tool: varchar('source_tool', { length: 32 }).notNull(),
    embedding: vector('embedding', { dimensions: 1024 }),
  },
  (t) => [
    index('scraped_pages_fetched_at_idx').on(t.fetched_at),
    index('scraped_pages_embedding_hnsw_idx').using('hnsw', t.embedding.op('vector_cosine_ops')),
  ],
);

export const heartbeats = pgTable(
  'heartbeats',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    user_id: text('user_id').notNull(),
    dm_channel_id: text('dm_channel_id'),
    cadence: varchar('cadence', { length: 16 }).notNull(),
    scan_prompt: text('scan_prompt').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    last_run_at: timestamp('last_run_at', { withTimezone: true }),
    next_run_at: timestamp('next_run_at', { withTimezone: true }).notNull(),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('heartbeats_next_run_idx').on(t.next_run_at),
    index('heartbeats_user_idx').on(t.user_id),
  ],
);

export const routines = pgTable(
  'routines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    user_id: text('user_id').notNull(),
    channel_id: text('channel_id').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    trigger_kind: varchar('trigger_kind', { length: 16 }).notNull(),
    trigger_spec: jsonb('trigger_spec').notNull(),
    plan_prompt: text('plan_prompt').notNull(),
    tool_set_hash: text('tool_set_hash').notNull(),
    status: varchar('status', { length: 16 }).notNull().default('pending'),
    approved_at: timestamp('approved_at', { withTimezone: true }),
    approved_by: text('approved_by'),
    last_run_at: timestamp('last_run_at', { withTimezone: true }),
    last_run_status: varchar('last_run_status', { length: 16 }),
    consecutive_failures: integer('consecutive_failures').notNull().default(0),
    next_run_at: timestamp('next_run_at', { withTimezone: true }),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('routines_status_idx').on(t.status, t.trigger_kind),
    index('routines_next_run_idx').on(t.next_run_at),
    index('routines_user_idx').on(t.user_id),
  ],
);

export const cron_jobs = pgTable(
  'cron_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    owner_user_id: text('owner_user_id').notNull(),
    owner_channel_id: text('owner_channel_id').notNull(),
    fire_at: timestamp('fire_at', { withTimezone: true }).notNull(),
    action_prompt: text('action_prompt').notNull(),
    active: boolean('active').default(true),
    fired_at: timestamp('fired_at', { withTimezone: true }),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('cron_jobs_fire_at_idx').on(t.fire_at),
    index('cron_jobs_owner_idx').on(t.owner_user_id, t.fire_at),
  ],
);

export const skills = pgTable(
  'skills',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    trigger_desc: text('trigger_desc').notNull(),
    steps: jsonb('steps').notNull(),
    params_schema: jsonb('params_schema'),
    version: integer('version').default(1),
    success_count: integer('success_count').default(0),
    fail_count: integer('fail_count').default(0),
    last_used_at: timestamp('last_used_at', { withTimezone: true }),
    active: boolean('active').default(true),
    embedding: vector('embedding', { dimensions: 1024 }),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('skills_active_idx').on(t.active, t.last_used_at),
    index('skills_embedding_hnsw_idx').using('hnsw', t.embedding.op('vector_cosine_ops')),
  ],
);

export const facts = pgTable(
  'facts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    subject: text('subject').notNull(),
    predicate: text('predicate').notNull(),
    object: text('object').notNull(),
    confidence: real('confidence').notNull().default(0.7),
    source_turn_id: uuid('source_turn_id'),
    scope: varchar('scope', { length: 16 }).notNull().default('user'),
    scope_id: text('scope_id'),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    last_seen_at: timestamp('last_seen_at', { withTimezone: true }).defaultNow().notNull(),
    contradicted: boolean('contradicted').default(false),
    pinned: boolean('pinned').notNull().default(false),
    embedding: vector('embedding', { dimensions: 1024 }),
  },
  (t) => [
    index('facts_scope_idx').on(t.scope, t.scope_id),
    index('facts_subject_idx').on(t.subject),
    index('facts_last_seen_idx').on(t.last_seen_at),
    index('facts_embedding_hnsw_idx').using('hnsw', t.embedding.op('vector_cosine_ops')),
  ],
);
