import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { env } from './config/env.js';
import { logger } from './logger.js';

let sdk: NodeSDK | null = null;

export function initTelemetry(): void {
  if (sdk) return;
  if (!env.OTEL_EXPORTER_OTLP_ENDPOINT) {
    logger.info('OTEL_EXPORTER_OTLP_ENDPOINT not set — telemetry disabled');
    return;
  }
  sdk = new NodeSDK({
    traceExporter: new OTLPTraceExporter({
      url: `${env.OTEL_EXPORTER_OTLP_ENDPOINT.replace(/\/$/, '')}/v1/traces`,
    }),
    instrumentations: [getNodeAutoInstrumentations()],
  });
  try {
    sdk.start();
    logger.info(
      { endpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT },
      'opentelemetry_started',
    );
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'otel_start_failed');
  }
}

export async function shutdownTelemetry(): Promise<void> {
  if (!sdk) return;
  try {
    await sdk.shutdown();
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'otel_shutdown_failed');
  }
}
