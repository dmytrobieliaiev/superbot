import { describe, expect, it } from 'vitest';
import { pickTiers } from '../../../src/tools/web/get.js';

describe('pickTiers', () => {
  it('defaults to web_fetch first for generic sites', () => {
    expect(pickTiers('https://example.com/docs')).toEqual([
      'web_fetch',
      'browser_render',
      'scraper_api',
    ]);
  });

  it('routes anti-bot hosts to scraper_api first', () => {
    expect(pickTiers('https://www.autoscout24.de/lst/bmw')[0]).toBe('scraper_api');
    expect(pickTiers('https://amazon.com/dp/X')[0]).toBe('scraper_api');
    expect(pickTiers('https://kleinanzeigen.de')[0]).toBe('scraper_api');
  });

  it('routes JS-heavy SPAs to browser_render first', () => {
    expect(pickTiers('https://x.com/foo/status/123')[0]).toBe('browser_render');
    expect(pickTiers('https://notion.so/page')[0]).toBe('browser_render');
    expect(pickTiers('https://reddit.com/r/x')[0]).toBe('browser_render');
  });

  it('handles subdomain matches', () => {
    expect(pickTiers('https://api.linear.app/foo')[0]).toBe('browser_render');
    expect(pickTiers('https://shop.amazon.de/x')[0]).toBe('scraper_api');
  });

  it('falls back gracefully for invalid URL', () => {
    // hostOf returns '' → no match → default tier order
    expect(pickTiers('not-a-url')[0]).toBe('web_fetch');
  });
});
