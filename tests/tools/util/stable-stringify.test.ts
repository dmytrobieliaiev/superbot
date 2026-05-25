import { describe, expect, it } from 'vitest';
import { stableStringify } from '../../../src/tools/util/stable-stringify.js';

describe('stableStringify', () => {
  it('handles primitives', () => {
    expect(stableStringify(1)).toBe('1');
    expect(stableStringify('a')).toBe('"a"');
    expect(stableStringify(null)).toBe('null');
    expect(stableStringify(true)).toBe('true');
  });

  it('arrays preserve order', () => {
    expect(stableStringify([3, 1, 2])).toBe('[3,1,2]');
  });

  it('object keys sorted', () => {
    expect(stableStringify({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it('deep object sort', () => {
    expect(stableStringify({ b: { d: 1, c: 2 }, a: 3 })).toBe(
      '{"a":3,"b":{"c":2,"d":1}}',
    );
  });

  it('produces identical output for equivalent objects regardless of key insertion order', () => {
    const a = stableStringify({ x: 1, y: 2 });
    const b = stableStringify({ y: 2, x: 1 });
    expect(a).toBe(b);
  });

  it('handles nested arrays of objects', () => {
    const result = stableStringify([{ b: 1, a: 2 }, { d: 3, c: 4 }]);
    expect(result).toBe('[{"a":2,"b":1},{"c":4,"d":3}]');
  });
});
