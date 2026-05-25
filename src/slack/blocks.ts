// Minimal Block Kit helpers + sanity validation.
// Agent emits either a JSON blocks array directly (via slack_blocks tool) or
// embeds a fenced <<<BLOCKS>>>…<<<END>>> region at the end of the final reply.

const MAX_BLOCKS = 50;
const MAX_TEXT_LEN = 3000;

export interface Block {
  type: string;
  [k: string]: unknown;
}

export interface ParseResult {
  /** Reply text with the fenced region removed. */
  text: string;
  /** Parsed blocks if a valid fence was found. */
  blocks: Block[] | null;
  /** True when a fence was detected but failed to parse. */
  malformed: boolean;
}

const FENCE_RE = /<<<BLOCKS>>>\s*([\s\S]*?)\s*<<<END>>>/i;

export function parseInlineBlocks(text: string): ParseResult {
  const m = FENCE_RE.exec(text);
  if (!m) return { text, blocks: null, malformed: false };
  const raw = m[1] ?? '';
  const stripped = text.replace(FENCE_RE, '').trim();
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed) && parsed.every((b) => isBlock(b))) {
      return { text: stripped, blocks: clampBlocks(parsed as Block[]), malformed: false };
    }
    if (isPlainObject(parsed) && Array.isArray((parsed as { blocks?: unknown }).blocks)) {
      const arr = (parsed as { blocks: unknown[] }).blocks;
      if (arr.every((b) => isBlock(b))) {
        return { text: stripped, blocks: clampBlocks(arr as Block[]), malformed: false };
      }
    }
    return { text: stripped, blocks: null, malformed: true };
  } catch {
    return { text: stripped, blocks: null, malformed: true };
  }
}

function isBlock(v: unknown): v is Block {
  return isPlainObject(v) && typeof (v as { type?: unknown }).type === 'string';
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function clampBlocks(blocks: Block[]): Block[] {
  return blocks.slice(0, MAX_BLOCKS).map(clampBlock);
}

function clampBlock(b: Block): Block {
  if (b.type === 'section' && isPlainObject(b.text)) {
    const t = b.text as { type?: string; text?: unknown };
    if (typeof t.text === 'string' && t.text.length > MAX_TEXT_LEN) {
      t.text = t.text.slice(0, MAX_TEXT_LEN - 1) + '…';
    }
  }
  if (b.type === 'header' && isPlainObject(b.text)) {
    const t = b.text as { type?: string; text?: unknown };
    if (typeof t.text === 'string' && t.text.length > 150) {
      t.text = t.text.slice(0, 149) + '…';
    }
  }
  return b;
}

// — convenience builders (agent can use these via prompt hints) —

export function header(text: string): Block {
  return { type: 'header', text: { type: 'plain_text', text } };
}

export function section(markdown: string): Block {
  return { type: 'section', text: { type: 'mrkdwn', text: markdown } };
}

export function divider(): Block {
  return { type: 'divider' };
}

export function fields(pairs: Array<[string, string]>): Block {
  return {
    type: 'section',
    fields: pairs.map(([k, v]) => ({ type: 'mrkdwn', text: `*${k}*\n${v}` })),
  };
}

export function context(elements: string[]): Block {
  return {
    type: 'context',
    elements: elements.map((t) => ({ type: 'mrkdwn', text: t })),
  };
}

export function actions(
  buttons: Array<{
    text: string;
    action_id: string;
    value?: string;
    url?: string;
    style?: 'primary' | 'danger';
  }>,
): Block {
  return {
    type: 'actions',
    elements: buttons.map((b) => {
      const el: Record<string, unknown> = {
        type: 'button',
        text: { type: 'plain_text', text: b.text },
        action_id: b.action_id,
      };
      if (b.value) el.value = b.value;
      if (b.url) el.url = b.url;
      if (b.style) el.style = b.style;
      return el;
    }),
  };
}
