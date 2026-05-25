import { describe, expect, it } from 'vitest';
import {
  actions,
  clampBlocks,
  context,
  divider,
  fields,
  header,
  parseInlineBlocks,
  section,
} from '../../src/slack/blocks.js';

describe('parseInlineBlocks', () => {
  it('returns the input unchanged when no fence present', () => {
    const r = parseInlineBlocks('hello world');
    expect(r.text).toBe('hello world');
    expect(r.blocks).toBeNull();
    expect(r.malformed).toBe(false);
  });

  it('parses a JSON array fence', () => {
    const input = `intro\n\n<<<BLOCKS>>>\n[{"type":"section","text":{"type":"mrkdwn","text":"hi"}}]\n<<<END>>>`;
    const r = parseInlineBlocks(input);
    expect(r.text).toBe('intro');
    expect(r.blocks).toHaveLength(1);
    expect(r.blocks?.[0]?.type).toBe('section');
    expect(r.malformed).toBe(false);
  });

  it('parses a {blocks:[...]} envelope', () => {
    const input = `<<<BLOCKS>>>\n{"blocks":[{"type":"divider"}]}\n<<<END>>>`;
    const r = parseInlineBlocks(input);
    expect(r.text).toBe('');
    expect(r.blocks).toHaveLength(1);
    expect(r.blocks?.[0]?.type).toBe('divider');
  });

  it('marks malformed JSON', () => {
    const input = `txt\n\n<<<BLOCKS>>>\n[not json,]\n<<<END>>>`;
    const r = parseInlineBlocks(input);
    expect(r.malformed).toBe(true);
    expect(r.blocks).toBeNull();
    expect(r.text).toBe('txt'); // fence stripped even when malformed
  });

  it('rejects payload that is not an array or {blocks:[]}', () => {
    const input = `x\n\n<<<BLOCKS>>>\n{"random":"object"}\n<<<END>>>`;
    const r = parseInlineBlocks(input);
    expect(r.malformed).toBe(true);
    expect(r.blocks).toBeNull();
  });

  it('rejects array items missing a string type', () => {
    const input = `x\n\n<<<BLOCKS>>>\n[{"foo":"bar"}]\n<<<END>>>`;
    const r = parseInlineBlocks(input);
    expect(r.malformed).toBe(true);
  });

  it('strips ONLY the first fence (rest stays in text)', () => {
    const input = `<<<BLOCKS>>>\n[{"type":"divider"}]\n<<<END>>>\n\nafter <<<BLOCKS>>> not a fence`;
    const r = parseInlineBlocks(input);
    expect(r.blocks).toHaveLength(1);
    expect(r.text).toContain('after <<<BLOCKS>>> not a fence');
  });

  it('case-insensitive fence match', () => {
    const input = `<<<blocks>>>\n[{"type":"divider"}]\n<<<end>>>`;
    const r = parseInlineBlocks(input);
    expect(r.blocks).toHaveLength(1);
  });
});

describe('clampBlocks', () => {
  it('truncates oversized section text to ~3000 chars', () => {
    const big = 'a'.repeat(4000);
    const b = clampBlocks([{ type: 'section', text: { type: 'mrkdwn', text: big } }]);
    const text = (b[0]?.text as { text?: string } | undefined)?.text ?? '';
    expect(text.length).toBeLessThanOrEqual(3000);
    expect(text.endsWith('…')).toBe(true);
  });

  it('truncates oversized header text', () => {
    const big = 'h'.repeat(300);
    const b = clampBlocks([{ type: 'header', text: { type: 'plain_text', text: big } }]);
    const text = (b[0]?.text as { text?: string } | undefined)?.text ?? '';
    expect(text.length).toBeLessThanOrEqual(150);
  });

  it('caps blocks array to 50', () => {
    const arr = Array.from({ length: 80 }, () => ({ type: 'divider' }));
    expect(clampBlocks(arr)).toHaveLength(50);
  });

  it('leaves small blocks untouched', () => {
    const arr = [{ type: 'section', text: { type: 'mrkdwn', text: 'hi' } }];
    const out = clampBlocks(arr);
    expect(out).toEqual(arr);
  });
});

describe('Block Kit builders', () => {
  it('header', () => {
    expect(header('Hi')).toEqual({ type: 'header', text: { type: 'plain_text', text: 'Hi' } });
  });

  it('section mrkdwn', () => {
    expect(section('*bold*')).toEqual({
      type: 'section',
      text: { type: 'mrkdwn', text: '*bold*' },
    });
  });

  it('divider', () => {
    expect(divider()).toEqual({ type: 'divider' });
  });

  it('fields produces 2-col grid', () => {
    const b = fields([['A', '1'], ['B', '2']]);
    expect(b.type).toBe('section');
    expect((b as { fields?: unknown[] }).fields).toHaveLength(2);
  });

  it('context', () => {
    const b = context(['note']);
    expect((b as { elements: Array<{ text: string }> }).elements[0]?.text).toBe('note');
  });

  it('actions builds button block with style/url/value', () => {
    const b = actions([
      { text: 'Approve', action_id: 'a', value: 'v', style: 'primary' },
      { text: 'Docs', action_id: 'b', url: 'https://x' },
    ]);
    const els = (b as { elements: Array<Record<string, unknown>> }).elements;
    expect(els).toHaveLength(2);
    expect(els[0]?.value).toBe('v');
    expect(els[0]?.style).toBe('primary');
    expect(els[1]?.url).toBe('https://x');
    // omitted optional props should not appear
    expect('style' in (els[1] ?? {})).toBe(false);
    expect('value' in (els[1] ?? {})).toBe(false);
  });
});
