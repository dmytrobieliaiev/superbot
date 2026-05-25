import { describe, expect, it } from 'vitest';
import { nextCronFire, parseCron } from '../../src/jobs/cron-parse.js';

describe('parseCron', () => {
  it('parses a 5-field expression', () => {
    const f = parseCron('0 9 * * 1');
    expect(f[0]).toEqual([0]);
    expect(f[1]).toEqual([9]);
    expect(f[2]).toHaveLength(31); // all DoM
    expect(f[3]).toHaveLength(12); // all months
    expect(f[4]).toEqual([1]);
  });

  it('expands ranges', () => {
    const f = parseCron('0 9-11 * * *');
    expect(f[1]).toEqual([9, 10, 11]);
  });

  it('expands step (*/n)', () => {
    const f = parseCron('*/15 * * * *');
    expect(f[0]).toEqual([0, 15, 30, 45]);
  });

  it('expands comma lists', () => {
    const f = parseCron('0,30 * * * *');
    expect(f[0]).toEqual([0, 30]);
  });

  it('combines range + step', () => {
    const f = parseCron('0-30/10 * * * *');
    expect(f[0]).toEqual([0, 10, 20, 30]);
  });

  it('throws on wrong field count', () => {
    expect(() => parseCron('* * * *')).toThrow(/5 fields/);
    expect(() => parseCron('* * * * * *')).toThrow(/5 fields/);
  });
});

describe('nextCronFire', () => {
  it('every minute fires the next minute', () => {
    const from = new Date('2026-01-15T10:30:30.000Z');
    const next = nextCronFire('* * * * *', from);
    // next minute boundary
    expect(next.toISOString()).toBe('2026-01-15T10:31:00.000Z');
  });

  it('hourly fires at next hour 0-min', () => {
    const from = new Date('2026-01-15T10:30:00.000Z');
    const next = nextCronFire('0 * * * *', from);
    expect(next.toISOString()).toBe('2026-01-15T11:00:00.000Z');
  });

  it('daily 09:00 UTC fires next 09:00', () => {
    const from = new Date('2026-01-15T15:00:00.000Z');
    const next = nextCronFire('0 9 * * *', from);
    expect(next.toISOString()).toBe('2026-01-16T09:00:00.000Z');
  });

  it('monday 09:00 fires next monday', () => {
    // 2026-01-15 = Thursday
    const from = new Date('2026-01-15T10:00:00.000Z');
    const next = nextCronFire('0 9 * * 1', from);
    expect(next.getUTCDay()).toBe(1);
    expect(next.getUTCHours()).toBe(9);
    expect(next.getUTCDate()).toBe(19); // Mon 2026-01-19
  });

  it('handles late-in-day "today" fire if still future', () => {
    const from = new Date('2026-01-15T08:00:00.000Z');
    const next = nextCronFire('0 9 * * *', from);
    expect(next.toISOString()).toBe('2026-01-15T09:00:00.000Z');
  });
});
