import { readFileSync } from 'node:fs';
import { parse as yamlParse } from 'yaml';
import { z } from 'zod';

const PricesSchema = z.object({
  models: z.record(
    z.object({
      input_per_1m: z.number(),
      output_per_1m: z.number(),
    }),
  ),
});

type Prices = z.infer<typeof PricesSchema>;

let pricesCache: Prices | null = null;

function loadPrices(): Prices {
  if (pricesCache) return pricesCache;
  const raw = readFileSync('config/prices.yaml', 'utf-8');
  pricesCache = PricesSchema.parse(yamlParse(raw));
  return pricesCache;
}

export interface ModelPrice {
  input_per_1m: number;
  output_per_1m: number;
}

const FALLBACK: ModelPrice = { input_per_1m: 5, output_per_1m: 15 };

export function priceFor(model: string): ModelPrice {
  const prices = loadPrices();
  return prices.models[model] ?? prices.models['default'] ?? FALLBACK;
}

export function computeCost(
  model: string,
  tokensIn: number,
  tokensOut: number,
): number {
  const p = priceFor(model);
  return (tokensIn / 1_000_000) * p.input_per_1m + (tokensOut / 1_000_000) * p.output_per_1m;
}
