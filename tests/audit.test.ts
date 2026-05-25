import { describe, expect, it } from 'vitest';
import { chainHash } from '../src/audit.js';

describe('chainHash', () => {
  const ts = new Date('2026-01-15T12:00:00.000Z');

  it('produces stable hash for identical input', () => {
    const a = chainHash(null, ts, 'agent', 'turn_replied', { x: 1, y: 2 });
    const b = chainHash(null, ts, 'agent', 'turn_replied', { y: 2, x: 1 });
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
  });

  it('different parent_hash → different self_hash', () => {
    const a = chainHash(null, ts, 'agent', 'x', {});
    const b = chainHash('aabbcc', ts, 'agent', 'x', {});
    expect(a).not.toBe(b);
  });

  it('different action → different self_hash', () => {
    const a = chainHash(null, ts, 'agent', 'action1', {});
    const b = chainHash(null, ts, 'agent', 'action2', {});
    expect(a).not.toBe(b);
  });

  it('different timestamp → different self_hash', () => {
    const ts2 = new Date('2026-01-15T12:00:01.000Z');
    const a = chainHash(null, ts, 'agent', 'x', {});
    const b = chainHash(null, ts2, 'agent', 'x', {});
    expect(a).not.toBe(b);
  });
});
