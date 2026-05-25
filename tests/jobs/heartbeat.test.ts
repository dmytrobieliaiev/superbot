import { describe, expect, it } from 'vitest';
import { toolSetHash } from '../../src/jobs/heartbeat.js';

describe('toolSetHash', () => {
  it('is order-independent', () => {
    expect(toolSetHash(['a', 'b', 'c'])).toBe(toolSetHash(['c', 'a', 'b']));
  });

  it('changes when a tool is added', () => {
    expect(toolSetHash(['a', 'b'])).not.toBe(toolSetHash(['a', 'b', 'c']));
  });

  it('changes when a tool is removed', () => {
    expect(toolSetHash(['a', 'b', 'c'])).not.toBe(toolSetHash(['a', 'b']));
  });

  it('stable across calls with same input', () => {
    expect(toolSetHash(['x', 'y'])).toBe(toolSetHash(['x', 'y']));
  });

  it('returns 16-char hex', () => {
    const h = toolSetHash(['x']);
    expect(h).toMatch(/^[a-f0-9]{16}$/);
  });
});
