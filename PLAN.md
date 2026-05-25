# Slack Agent — Build Plan

Internal Slack agent. TypeScript/Node + Postgres + pgvector + Docker. OpenAI-compatible LLM. Memory (episodic + semantic + procedural) + 18 tools. Self-improving via trajectory logs + eval harness.

---

## 0. Locked Decisions

| Item | Choice |
|---|---|
| Scope | Single Slack workspace, internal team, ~200 users |
| Backend | Node 20 + TypeScript (ESM) |
| LLM | OpenAI-compatible endpoint, env-driven (`LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL=opus`) |
| DB | Postgres 16 + pgvector |
| Queue | BullMQ on Redis |
| Storage | MinIO (S3-compatible) |
| Hosting | Docker Compose on single VPS |
| Slack transport | Socket Mode |
| Slack identity | Own Slack App with bot user + "App" badge |
| Compliance | No GDPR scope (internal team only) |

---

## 1. Goals

- Slack-native: channels + DMs, threads-aware
- Persistent memory across sessions: episodic + semantic + procedural
- 18 tools — web search + scraping + PDF first-class
- Self-improving via trajectory logging + weekly eval
- Hermes-scar mitigations baked in from day 1

Non-goals (v1): multi-tenant SaaS, fine-tuned models, voice, mobile.

---

## 2. Architecture

```
                  ┌──────────────┐
                  │    Slack     │ Socket Mode WS
                  └──────┬───────┘
                         │ events
                         ▼
        ┌────────────────────────────────────┐
        │  INGEST  (Bolt + dedupe + ACL)     │
        └────────────────┬───────────────────┘
                         │ enqueue
                         ▼
                 ┌───────────────┐
                 │ Redis Queue   │ BullMQ
                 └───────┬───────┘
                         │ consume
                         ▼
        ┌────────────────────────────────────┐
        │  RESPONSE GEN  (LLM tool-loop)     │
        │  ┌─────────────────────────────┐   │
        │  │ MEMORY READ (parallel fanout)│  │
        │  └─────────────────────────────┘   │
        │  ┌─────────────────────────────┐   │
        │  │ TOOL EXEC (18 tools, ACL)   │   │
        │  └─────────────────────────────┘   │
        └────────────────┬───────────────────┘
                         │ output
                         ▼
        ┌────────────────────────────────────┐
        │  POST  (text/file/PDF to Slack)    │
        └────────────────┬───────────────────┘
                         │ post-turn fanout
        ┌────────────────┴───────────────────┐
        ▼                ▼                   ▼
  ┌──────────┐    ┌─────────────┐    ┌──────────────┐
  │ EPISODIC │    │ FACT EXTRACT│    │ SKILL MINER  │
  │  writer  │    │ (async job) │    │ (gated)      │
  └────┬─────┘    └─────┬───────┘    └──────┬───────┘
       │                │                   │
       ▼                ▼                   ▼
  ┌────────────────────────────────────────────────┐
  │            Postgres + pgvector                 │
  │   messages, facts, skills, trajectories,       │
  │   audit_log, user_profile, scraped_pages       │
  └────────────────────────────────────────────────┘
```

---

## 3. Pipeline 1 — Ingest

### 3.1 Sources
- Slack Events API via Socket Mode (Bolt JS)
- Slash commands (`/ask`, `/memory`, `/forget`, `/skill`, `/help`)
- Message shortcuts ("Ask agent about this")
- Interactive payloads (buttons, modals)
- Internal scheduler (cron firing)

### 3.2 Flow

```
WS event arrives
   │
   ▼ ACK within 3s (always)
   ▼ Drop if bot's own message (echo loop guard)
   ▼ Idempotency: SETNX redis "evt:{event_id}" TTL 24h
   ▼ Parse → InboundEvent { event_id, ts, channel_id, channel_type,
                            user_id, thread_ts, text, files[],
                            mentions[], kind }
   ▼ Enrich (parallel):
         - users.info → name, tz, role
         - conversations.info → channel name, topic
         - thread context if thread_ts → last 20 msgs cached
         - resolve user_profile from DB
   ▼ ACL gate: channel allowlist + user denylist + kind enabled
   ▼ Enqueue → BullMQ "turns" queue
         priority: dm=high, mention=med, scheduled=low
         payload: enriched InboundEvent
```

### 3.3 Edge cases
- Slack retries on slow ack → dedupe key
- Bot edits message → ignore unless flagged
- Thread join mid-conversation → fetch backlog
- File too large → skip download, note path
- Slack 429 → respect `Retry-After`

---

## 4. Pipeline 2 — Memory

### 4.1 Three layers

| Layer | Content | Table | Decay |
|---|---|---|---|
| Episodic | raw turns, transcripts | `messages` (+vector chunks) | TTL 90d |
| Semantic | extracted facts | `facts` (+embedding) | confidence decay |
| Procedural | skills/recipes | `skills` (+embedding, +version) | manual prune |

Support: `user_profile`, `thread_summary`, `scraped_pages`, `audit_log`.

### 4.2 Schema sketch

```
messages
   id (uuid), turn_id, channel_id, user_id, thread_ts,
   role (user|assistant|tool), content (text),
   tool_calls (jsonb), tool_results (jsonb),
   tokens, cost_usd, latency_ms, ts, embedding (vector[1536])

facts
   id, subject, predicate, object, confidence (0..1),
   source_turn_id, scope (user|channel|global),
   created_at, last_seen_at, contradicted (bool),
   embedding (vector[1536])

skills
   id, name, trigger_desc, steps (jsonb), params_schema (jsonb),
   version, success_count, fail_count, last_used_at,
   embedding (vector[1536])

user_profile
   slack_user_id (pk), name, tz, region, role, prefs (jsonb),
   created_at, updated_at

thread_summary
   thread_ts (pk), channel_id, summary (text), last_msg_ts, turn_count

scraped_pages
   url (pk, hashed), fetched_at, content_md, title,
   embedding (vector[1536]), source_tool

audit_log
   id, ts, actor (agent|user), action, payload (jsonb),
   parent_hash (text), self_hash (text)

trajectories
   turn_id (pk), user_id, channel_id, full_log (jsonb),
   outcome (done|abandoned|errored|handoff),
   feedback (jsonb), tokens, cost_usd
```

### 4.3 Write path (post-turn)

```
turn_end signal
   │
   ├─ SYNC: insert messages row (with embedding)
   │        chunk content >400 tok → separate vector rows
   │
   ├─ ASYNC job → fact_extract
   │   LLM: "extract SVO triples + confidence from this turn"
   │   for each candidate:
   │     ANN search nearest existing fact
   │     if cosine > 0.92 → LLM merge/replace
   │     else insert new
   │
   ├─ ASYNC job → skill_mine
   │   gate: tool_calls >= 3 AND outcome == success
   │         OR user said "/save-skill"
   │   LLM: "generalize this trajectory into reusable skill"
   │   embed trigger description → insert
   │
   ├─ ASYNC job → summarize_thread
   │   gate: turn_count_for_thread % 20 == 0
   │   LLM: compact older turns, keep last 10 verbatim
   │   upsert thread_summary
   │
   └─ SYNC: append audit_log w/ hash chain
```

### 4.4 Read path (pre-LLM call)

```
intent + query in
   │
   ▼ Parallel fanout:
         - recent_turns(thread_ts, K=10)      SQL
         - thread_summary(thread_ts)          SQL
         - user_profile(user_id)              SQL
         - semantic_facts(query, scope, K=8)  pgvector ANN + scope
         - episodic_recall(query, K=5)        pgvector ANN cross-thread
         - candidate_skills(query, K=3)       pgvector ANN on triggers
   │
   ▼ PACKER (token budget aware, default 8k for context)
         priority order:
           1. user_profile (always, ~100 tok)
           2. recent_turns (always, ~1500 tok)
           3. candidate_skills (~500 tok)
           4. semantic_facts (~800 tok)
           5. episodic_recall (~1500 tok)
           6. thread_summary (~500 tok)
         strip dupes (text hash)
         emit context blocks
```

### 4.5 Governance commands

| Command | Effect |
|---|---|
| `/memory show` | DMs user list of facts agent stores about them |
| `/forget <topic>` | Deletes matching facts + episodic entries |
| `/remember <text>` | Pin fact, confidence=1.0, no decay |
| `/skill list` | Show learned skills |
| `/skill delete <id>` | Remove skill |
| `/audit <turn_id>` | Hash-chained log of agent actions for that turn |

### 4.6 Privacy + decay

- Facts unused 60d → confidence × 0.8 nightly job
- Episodic TTL 90d → purge job (configurable per channel)
- DM content never used as semantic fact source unless user opts in
- Cross-user fact inference disabled (scope=user by default)

---

## 5. Pipeline 3 — Train (lightweight)

### 5.1 Stage 1 — trajectory logging (always-on)

Every turn logged to `trajectories`:
```
{
  turn_id, user_id, channel_id,
  prompt_input, system_msg, context_blocks,
  llm_calls[]: { model, messages, tools, response, tokens, latency },
  tool_executions[]: { name, args, result, error, latency },
  final_output,
  feedback: { reactji[], explicit_correction },
  outcome: done | abandoned | errored | handoff,
  metrics: { total_tokens, cost_usd, total_latency_ms }
}
```

Nightly export → MinIO `s3://traj/YYYY-MM-DD.jsonl.gz`

### 5.2 Stage 2 — eval harness

```
weekly job (Sunday 02:00):
   pull 20 random successful turns from past week
   present to maintainer in Slack DM → 👍/👎/edit
   approved → add to eval_set

eval_set (~100 cases target):
   { input_event, expected_tool_calls (loose), expected_outcome,
     rubric: helpful (0-3), correct (0-3), grounded (0-3) }

nightly regression run:
   replay full eval_set against current agent
   LLM-judge scores each
   diff vs last run → post regression report to #agent-ops
   alert if avg score drops > 0.3
```

### 5.3 Stage 3 — fine-tune (deferred)

Skip until prompt-eng plateaus. If revisited:
- Target: small open model (Qwen 2.5 7B / Llama 3 8B) for intent routing only
- Main agent stays on frontier model
- DPO pairs from 👍/👎 reactji

---

## 6. Pipeline 4 — Response Generation

```
job dequeued from turns queue
   │
   ▼ INTENT ROUTER (small/cheap LLM call OR rules)
         labels: chitchat | task | direct_tool | command | handoff
         command → dispatch directly (no LLM loop)
         chitchat → minimal context, short response
         task → full pipeline
   │
   ▼ MEMORY READ (parallel fanout, §4.4)
   │
   ▼ PLANNER (gated: task + complexity heuristic)
         heuristic: long query OR multi-clause OR "and then"
         if complex → LLM: "given goal + tools + memory, sketch 3-7 step plan"
         plan surfaced to user as initial message
   │
   ▼ TOOL-USE LOOP (max 25 steps, configurable per channel)
         while step < MAX and budget not blown:
            LLM call: system + context + history + tools
            if response.final_text → break
            for tool_call in response.tool_calls:
               ACL check (channel + user)
               rate limit check
               destructive? → ask user confirm via modal
               execute (timeout, retry policy)
               truncate result if > 8k tokens (full stored, ref returned)
               append observation to history
               on error → classify (retry|auth|user-fix)
            step++
            budget check (tokens, cost, time)
   │
   ▼ OUTPUT HANDLER
         text ≤ 40k → chat.postMessage in thread
         text > 40k → upload as canvas/file, post link
         code → ``` fenced, ≤ 4k inline, else file
         image → files.uploadV2
         pdf → files.uploadV2
         table → markdown if ≤ 20 rows else canvas
         add reactji 🤖 (traceability)
         add interactive blocks: [✏️ correct] [🔄 retry] [💾 save as skill]
   │
   ▼ POST-TURN HOOKS (async fanout)
         episodic writer, fact extractor, skill miner, thread summary,
         trajectory logger, audit log chain append
```

### 6.1 Runaway safety

No per-turn or per-user budget caps (M5.5 removed). Single safety net:
`MAX_ITERATIONS = 50` in tool-loop prevents an LLM that never stops calling tools.
Tokens + cost still logged per turn for observability.

### 6.2 Concurrency safety

- **Per-thread lock**: only one turn-in-flight per `thread_ts`. Redis `SET NX EX 300`. Lock-busy → BullMQ `moveToDelayed(+3s)`. Coherent replies within a thread.
- **Turn idempotency**: `turn_state` table tracks `event_id → status='replied'`. BullMQ retries that already posted to Slack skip on re-entry.
- **Sync user-msg write**: `writeEpisodic({role: 'user'})` awaited before LLM call. Subsequent turns / retries see it.
- **Bot auth before subscribe**: `auth.test()` resolved before handlers register. Echo-loop guard reliable from event 1.
- **Pending-promise tracker**: `track()` wraps fire-and-forget async writes. Shutdown drains via `flushPending(10s)`.

---

## 7. Tools (18)

### 7.1 Catalog

| # | Tool | Backend | Timeout | Cost/call | Scope |
|---|---|---|---|---|---|
| 1 | web_search | Tavily | 15s | $0.001 | open |
| 2 | web_fetch | Jina Reader | 20s | $0 | open |
| 3 | deep_research | Exa | 20s | $0.005 | open |
| 4 | slack_search | Slack API | 10s | $0 | workspace |
| 5 | slack_post | Slack API | 5s | $0 | allowlist channels |
| 6 | memory_recall | pgvector | 1s | $0 | self |
| 7 | calendar | Google Cal | 10s | $0 | per-user OAuth |
| 8 | github | gh API | 15s | $0 | repo allowlist |
| 9 | linear | Linear API | 15s | $0 | workspace |
| 10 | db_query | PG read-only | 30s | $0 | analytics DB only |
| 11 | code_sandbox | E2B or Modal | 60s | $0.01 | open |
| 12 | file_read | tika/pdf-parse | 30s | $0 | Slack uploads |
| 13 | vision | OpenAI-compat | 15s | $0.01 | open |
| 14 | image_gen | Replicate | 60s | $0.05 | rate-limited |
| 15 | scheduler | internal cron | 1s | $0 | open (sandboxed) |
| 16 | browser_render | Playwright/Browserless | 60s | $0.005 | domain allowlist |
| 17 | pdf_render | Gotenberg | 30s | $0 | open |
| 18 | scraper_api | Firecrawl | 90s | $0.01 | budget-gated |

### 7.2 Web/scrape routing

```
need page content
   │
   ├─ static SSR (blog, docs) ────────▶ web_fetch (Jina)  cheapest
   ├─ JS render, no anti-bot ─────────▶ browser_render
   ├─ anti-bot or marketplace ────────▶ scraper_api
   ├─ login/session needed ───────────▶ browser_render w/ stored session
   └─ research, semantic discovery ───▶ deep_research (Exa)
```

24h Redis cache in front of all four, key = hash(url + extraction_params).

### 7.3 Tool framework

Each tool implements:
- `name`, `description`, `params_schema` (JSON Schema for LLM)
- `execute(args, ctx) → result | error`
- `acl(ctx) → bool`
- `cost_estimate(args) → usd`
- `truncate(result) → { excerpt, full_ref }`

Result envelope:
```
{
  status: ok | error,
  content: string,        ← what LLM sees (truncated)
  artifacts: [             ← stored in MinIO, linkable
    { name, mime, url, size_bytes }
  ],
  meta: { latency_ms, cost_usd, cache_hit }
}
```

### 7.4 Self-modify guard

Tools forbidden from touching:
- Agent's own Postgres DB (write)
- Agent's config files
- Agent's source code
- Agent's running processes
- Agent's supervisor (systemd/docker)

Enforced via: dedicated PG read-only role for `db_query`, separate filesystem mount for `code_sandbox`, no shell access to host. (Hermes scar: cron self-destruct.)

---

## 8. Infrastructure

### 8.1 Docker Compose services

```
services:
  app                Node 20, Bolt + agent core
  postgres           PG 16 + pgvector
  redis              cache + queue
  minio              S3 storage for artifacts
  browserless        Chromium headless container
  gotenberg          HTML→PDF service
  worker             same image as app, runs BullMQ workers
  cron               BullMQ scheduled jobs
```

Resource footprint:
```
app + worker + cron   2 vCPU, 2 GB
postgres              1 vCPU, 1 GB
redis                 0.5 vCPU, 256 MB
minio                 0.5 vCPU, 512 MB
browserless           1 vCPU, 1 GB
gotenberg             0.5 vCPU, 512 MB
                    ─────────────────
total target VPS      4-6 vCPU, 6 GB
```

Fits Hetzner CCX13 (€15/mo) or DO 4GB droplet.

### 8.2 External SaaS (cost ceiling ~$100/mo)

| Service | Purpose | Tier |
|---|---|---|
| LLM provider | inference (OpenAI/OpenRouter) | pay-as-you-go ~$50/mo |
| Tavily | web_search | free 1k/mo or $30/mo |
| Exa | deep_research | $10/mo |
| Jina Reader | web_fetch | free 1M tok/mo |
| Firecrawl | scraper_api | $19/mo starter |
| Replicate | image_gen | pay-per-call ~$5/mo |

Self-host alternative: vLLM for LLM, SearXNG for search, removes ~$80/mo.

### 8.3 Secrets

- Doppler or sealed env file
- Per-tool API keys
- Slack bot token + app token + signing secret
- Postgres credentials, two roles: `agent_rw`, `agent_ro` (for db_query)
- LLM API key

### 8.4 Backup

- Postgres: pg_dump nightly → MinIO + offsite mirror weekly
- MinIO: lifecycle rules, replicate to cheap S3 weekly
- Audit log + trajectories: never auto-purged

---

## 9. Safety, Governance, Observability

### 9.1 Hermes-scar mitigations

| Hermes failure | Mitigation |
|---|---|
| Self-killing cron | Scheduler can't touch agent processes; allowlist resource types |
| Plugin DB corruption silent | Single PG, versioned migrations (drizzle), alert on schema drift |
| Provider param leakage | OpenAI-compat only; per-model capability matrix in config; never pass raw params |
| Output truncation | Length pre-check; >40k → file/canvas auto |
| Transport dupes | event_id dedupe + Redis SETNX |
| No audit trail | Hash-chained `audit_log` from day 1 |
| Memory weak | First-class 3-layer, not bolt-on |
| Rate-limit raw | Per-provider error classifier, exp backoff, circuit breaker |
| Agent self-modify | Tool ACL forbids own infra |
| Cost runaway | (removed by user choice) — only `MAX_ITERATIONS=50` runaway safety remains |

### 9.2 Observability

- Logs: pino structured JSON → Loki (or stdout + Docker driver)
- Traces: OpenTelemetry → Tempo / Jaeger; span per tool call, attach turn_id
- Metrics: Prometheus exporter; cost per turn, tool latency, queue depth, eval scores
- Dashboards: Grafana — single page, key tiles:
  - Turns/hour
  - Avg cost/turn
  - Tool success rate by tool
  - Eval regression trend
  - Queue depth + lag

### 9.3 Alerts (Slack `#agent-ops`)

- Queue depth > 50 for 5min
- Tool error rate > 20% for any tool, 10min window
- Daily cost > $20
- Eval score drop > 0.3 vs previous run
- PG connection pool exhausted
- Schema migration init-from-empty (data loss canary)

### 9.4 Audit log chain

```
each row:
   id, ts, actor, action, payload (jsonb),
   parent_hash, self_hash

self_hash = sha256(parent_hash || ts || actor || action || payload)
parent_hash = previous row's self_hash

verify_chain() utility runs daily → alert on break
```

Surfaces via `/audit <turn_id>` command.

---

## 10. Build Order (10 milestones)

| # | Milestone | Effort | Output |
|---|---|---|---|
| 1 | Ingest + dedupe + ack | 2d | Bot online, echoes |
| 2 | LLM loop, no tools | 2d | It talks |
| 3 | Episodic memory + recent context | 3d | Remembers thread |
| 4 | web_search + web_fetch + cache | 2d | It researches |
| 5 | Tool framework (ACL, timeout, retry, truncate) | 4d | Safe tool platform |
| 6 | Semantic memory (facts) + read packer | 4d | Cross-thread recall |
| 7 | Trajectory logging + eval harness v1 | 3d | Quality guard |
| 8 | Remaining tools (GitHub, calendar, DB, etc.) | 5d | Useful day-to-day |
| 9 | browser_render + scraper_api + pdf_render | 4d | Marketplace + PDF flows |
| 10 | Skill mining + governance commands | 3d | Self-improvement live |

Total: ~32 dev-days = **6-7 weeks for one engineer**.

Critical path: 1→2→3→5→6. Tools (4, 8, 9) parallelize once framework exists.

---

## 10.1 Architectural Debt — Durable Workflow Engine (planned)

### Why

Current durability = 7 hand-rolled mechanisms in a trenchcoat:

| Mechanism | Purpose |
|---|---|
| BullMQ queue + attempts/backoff | Job retry, basic persistence |
| `turn_state` table | Slack reply idempotency |
| Redis `SETNX` event dedup | Event-level dedup |
| Redis per-thread lock | Serial turn order in thread |
| `pg_advisory_xact_lock` (audit) | Audit chain serial writes |
| `track()` Promise set + `flushPending` | Best-effort drain on shutdown |
| `setTimeout` chains | Cron (decay, export, eval, audit, backup) |
| `setInterval` polls | scheduler runner, ops watchdog |

Each rolled separately. Failure semantics vary. Specific gaps current code **cannot** handle:

- Mid-turn crash loses tool-loop progress (e.g. iter 7 of 12 → restart redoes 1-7 if at all).
- `setTimeout` cron loses schedule on process restart.
- Fire-and-forget fact extraction / skill mining / summary trigger lost on shutdown unless `flushPending` window covers them.
- Cross-turn workflows (eval curation: DM → wait for click → insert) hand-correlated via Redis tokens. No native "block on signal".
- Per-step visibility is logs-only — no UI showing in-flight workflow state, retries, history.

### When to migrate

Trigger conditions (any one of):
1. Second nasty incident traceable to cron-restart-loss or async-write-loss.
2. Need for multi-turn human-in-the-loop workflows beyond simple modal confirm.
3. Multi-machine deployment (clustered workers) where Redis lock semantics get fragile.
4. Maintainer drowning in "why didn't this job run / retry / dedupe correctly" questions.

### Engine options (ranked for our shape)

| Engine | Fit | Op cost | Notes |
|---|---|---|---|
| **DBOS** | ⭐ best | Low | Postgres-backed (uses ours), decorator pattern, no new infra |
| **Inngest** | strong | Medium | Function-based, easy migration from async, SaaS or self-host |
| **Restate** | strong | Medium | Sync-style code, Postgres or built-in store, newer ecosystem |
| **Trigger.dev** | OK | Medium | OSS, dashboard mature, Inngest-like |
| **Hatchet** | OK | Medium | Temporal-like but lighter, Go server + JS SDK |
| **Temporal** | overkill | High | Best for 50+ workflow types; separate cluster + UI + workers |

### Migration sketch (DBOS — preferred)

- `turn-handler` → `@workflow` class with `@step()` for read-memory / tool-loop / post-reply / write-trajectory / extract-facts / mine-skill. Loop iteration checkpoints survive crash.
- 5 cron jobs (`decay`, `trajectory_export`, `eval_replay`, `audit_verify`, `db_backup`) → `@scheduledWorkflow`. Survives restart.
- `scheduler` tool's `cron_jobs` table → DBOS scheduled workflows (table goes away).
- Tools → activities w/ retry policies declared on the step.
- Redis per-thread lock → DBOS workflow concurrency key (`thread_ts`).
- `turn_state` idempotency → step idempotency keys.
- Audit advisory lock → workflow step (serial by design).

### Effort

~5-8 dev days end-to-end. Risk: DBOS younger than Temporal — SDK rough edges possible.

### Compromise (cheaper, non-migratory)

If full migration too heavy: replace `setTimeout` chains with **node-cron + checkpoint table** (`job_runs` table tracks `last_run_at` per job; on boot, run jobs that should have already fired). Fixes restart-loss without engine adoption. ~half-day effort. Leaves the rest of the trenchcoat intact.

### Decision

**Defer until incident.** Bottom-up rewrite for theoretical wins = premature. Re-evaluate after first month of live operation.

---

## 11. Open Questions

1. ~~LLM provider~~ — env-driven OpenAI-compat, `LLM_MODEL=opus`
2. ~~Workspace size~~ — 200 users
3. Existing data sources: any internal DB/wiki to wire up day-1?
4. ~~GDPR~~ — out of scope
5. ~~Identity model~~ — Slack App with bot user + "App" badge
6. Maintainer: who reviews eval Sunday DMs?
7. First killer use case: pick one (cars-PDF, ops report, ticket triage)?
