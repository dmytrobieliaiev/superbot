# superbot

Slack-native AI agent with persistent memory and 18 tools.

See [PLAN.md](./PLAN.md) for the full architecture, pipelines, and milestone roadmap.

## Quick start

Prereqs: Node 20+, pnpm 10+, Docker (for later milestones).

```bash
pnpm install
cp .env.example .env       # fill in values
pnpm dev                   # ts-node-dev style hot reload via tsx
```

## Scripts

| Command | Purpose |
|---|---|
| `pnpm dev` | Run with hot reload |
| `pnpm build` | Compile TS to `dist/` |
| `pnpm start` | Run compiled output |
| `pnpm typecheck` | Type-check without emit |
| `pnpm lint` | ESLint over `src/` |
| `pnpm format` | Prettier write |

## Layout

```
src/
  index.ts          # entrypoint
  config/env.ts     # zod-validated env
  logger.ts         # pino logger
```

Additional modules (ingest, memory, tools, worker) added per milestone.

## Roadmap

See `PLAN.md` §10 "Build Order" and the task list in the project (64 user stories).

Current: M1.1 (project skeleton).

## License

Internal.
