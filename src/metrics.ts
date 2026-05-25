import { createServer, type Server } from 'node:http';
import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from 'prom-client';
import { env } from './config/env.js';
import { logger } from './logger.js';

export const registry = new Registry();
collectDefaultMetrics({ register: registry });

export const m_turns_total = new Counter({
  name: 'superbot_turns_total',
  help: 'Total turns processed',
  labelNames: ['outcome', 'channel_type'] as const,
  registers: [registry],
});

export const m_llm_tokens = new Counter({
  name: 'superbot_llm_tokens_total',
  help: 'LLM tokens consumed (input + output)',
  labelNames: ['model', 'kind'] as const,
  registers: [registry],
});

export const m_llm_cost_usd = new Counter({
  name: 'superbot_llm_cost_usd_total',
  help: 'LLM cost in USD',
  labelNames: ['model'] as const,
  registers: [registry],
});

export const m_tool_calls = new Counter({
  name: 'superbot_tool_calls_total',
  help: 'Tool invocations',
  labelNames: ['tool', 'status'] as const,
  registers: [registry],
});

export const m_tool_errors = new Counter({
  name: 'superbot_tool_errors_total',
  help: 'Tool errors',
  labelNames: ['tool', 'error_code'] as const,
  registers: [registry],
});

export const m_turn_latency = new Histogram({
  name: 'superbot_turn_latency_seconds',
  help: 'Turn end-to-end latency',
  buckets: [0.5, 1, 2, 5, 10, 30, 60, 120],
  registers: [registry],
});

export const m_tool_latency = new Histogram({
  name: 'superbot_tool_latency_seconds',
  help: 'Per-tool latency',
  labelNames: ['tool'] as const,
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60],
  registers: [registry],
});

export const m_queue_depth = new Gauge({
  name: 'superbot_queue_depth',
  help: 'BullMQ turns queue depth (waiting+active)',
  registers: [registry],
});

export const m_critic_attempts = new Histogram({
  name: 'superbot_critic_attempts',
  help: 'Number of tool-loop attempts per turn (1 = ship first time, 2+ = critic retries)',
  buckets: [1, 2, 3, 4, 5],
  registers: [registry],
});

export const m_critic_action = new Counter({
  name: 'superbot_critic_action_total',
  help: 'Critic actions taken',
  labelNames: ['action'] as const,
  registers: [registry],
});

let server: Server | null = null;

export function startMetricsServer(): void {
  if (server) return;
  const port = env.METRICS_PORT;
  server = createServer(async (req, res) => {
    if (req.url === '/metrics') {
      res.writeHead(200, { 'Content-Type': registry.contentType });
      res.end(await registry.metrics());
      return;
    }
    if (req.url === '/health') {
      res.writeHead(200);
      res.end('ok');
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.on('error', (err) => {
    logger.error({ err: err.message, port }, 'metrics_server_error');
  });
  server.listen(port, () => {
    logger.info({ port }, 'metrics_server_started');
  });
}

export function stopMetricsServer(): Promise<void> {
  return new Promise((resolve) => {
    if (!server) return resolve();
    server.close(() => {
      server = null;
      resolve();
    });
  });
}
