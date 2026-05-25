#!/usr/bin/env tsx
// MCP server for self-hosted Outline (getoutline.com).
// Transport: stdio. Spawned by src/mcp/manager.ts via config/mcp.yaml.
//
// Env required:
//   OUTLINE_BASE_URL  e.g. https://outline.spendbase.internal
//   OUTLINE_API_TOKEN Bearer token from Outline account settings
//
// Exposed tools:
//   outline_search           — full-text search documents
//   outline_get_document     — fetch one document by id/share-id/url-id
//   outline_list_collections — list all collections (top-level groupings)
//   outline_list_documents   — list documents in a collection (optionally under a parent)

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const BASE_URL = process.env.OUTLINE_BASE_URL?.replace(/\/$/, '');
const TOKEN = process.env.OUTLINE_API_TOKEN;
const TIMEOUT_MS = 20_000;
const MAX_TEXT_BYTES = 60_000;

if (!BASE_URL || !TOKEN) {
  // Fatal: server can't start. Log to stderr (stdout is reserved for MCP traffic).
  // eslint-disable-next-line no-console
  console.error('outline-mcp: OUTLINE_BASE_URL and OUTLINE_API_TOKEN must be set');
  process.exit(2);
}

interface OutlineDoc {
  id: string;
  title: string;
  text?: string;
  url: string;
  urlId?: string;
  collectionId?: string;
  parentDocumentId?: string | null;
  createdAt?: string;
  updatedAt?: string;
  archivedAt?: string | null;
}

interface OutlineCollection {
  id: string;
  name: string;
  description?: string;
  url: string;
  updatedAt?: string;
}

async function api<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const resp = await fetch(`${BASE_URL}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`outline ${path} http_${resp.status}: ${text.slice(0, 300)}`);
    }
    return (await resp.json()) as T;
  } finally {
    clearTimeout(t);
  }
}

function truncate(text: string, max = MAX_TEXT_BYTES): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + '\n\n…[truncated]';
}

function jsonResult(data: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
  };
}

const server = new McpServer({ name: 'outline', version: '0.1.0' });

server.registerTool(
  'outline_search',
  {
    title: 'Search Outline documents',
    description:
      'Full-text search across the Outline workspace. Returns ranked document matches with id, title, url, and a short snippet.',
    inputSchema: {
      query: z.string().describe('Search query (required)'),
      limit: z.number().int().min(1).max(50).default(10).optional(),
      collection_id: z.string().optional().describe('Restrict to a single collection'),
      include_archived: z.boolean().default(false).optional(),
    },
  },
  async (args) => {
    const body: Record<string, unknown> = {
      query: args.query,
      limit: args.limit ?? 10,
      includeArchived: args.include_archived ?? false,
    };
    if (args.collection_id) body.collectionId = args.collection_id;
    const r = await api<{
      data: Array<{ context: string; document: OutlineDoc; ranking?: number }>;
    }>('/api/documents.search', body);
    const hits = (r.data ?? []).map((h) => ({
      id: h.document.id,
      title: h.document.title,
      url: h.document.url,
      snippet: truncate(h.context ?? '', 400),
      collection_id: h.document.collectionId,
      updated_at: h.document.updatedAt,
      ranking: h.ranking,
    }));
    return jsonResult({ query: args.query, count: hits.length, results: hits });
  },
);

server.registerTool(
  'outline_get_document',
  {
    title: 'Fetch an Outline document',
    description:
      'Fetch a single document by id, urlId, or share id. Returns title, full markdown text, url, and metadata.',
    inputSchema: {
      id: z.string().describe('Document id, urlId, or share id'),
    },
  },
  async (args) => {
    const r = await api<{ data: OutlineDoc }>('/api/documents.info', { id: args.id });
    const d = r.data;
    return jsonResult({
      id: d.id,
      title: d.title,
      url: d.url,
      collection_id: d.collectionId,
      parent_id: d.parentDocumentId,
      created_at: d.createdAt,
      updated_at: d.updatedAt,
      archived: !!d.archivedAt,
      text: truncate(d.text ?? ''),
    });
  },
);

server.registerTool(
  'outline_list_collections',
  {
    title: 'List Outline collections',
    description: 'List all top-level collections (knowledge spaces) in the workspace.',
    inputSchema: {
      limit: z.number().int().min(1).max(100).default(50).optional(),
    },
  },
  async (args) => {
    const r = await api<{ data: OutlineCollection[] }>('/api/collections.list', {
      limit: args.limit ?? 50,
    });
    const out = (r.data ?? []).map((c) => ({
      id: c.id,
      name: c.name,
      description: c.description,
      url: c.url,
      updated_at: c.updatedAt,
    }));
    return jsonResult({ count: out.length, collections: out });
  },
);

server.registerTool(
  'outline_list_documents',
  {
    title: 'List Outline documents in a collection',
    description:
      'List documents in a collection, optionally scoped under a parent document. Use for browsing the doc tree.',
    inputSchema: {
      collection_id: z.string().describe('Collection id'),
      parent_document_id: z
        .string()
        .optional()
        .describe('Restrict to children of this parent doc'),
      limit: z.number().int().min(1).max(100).default(25).optional(),
      offset: z.number().int().min(0).default(0).optional(),
    },
  },
  async (args) => {
    const body: Record<string, unknown> = {
      collectionId: args.collection_id,
      limit: args.limit ?? 25,
      offset: args.offset ?? 0,
    };
    if (args.parent_document_id) body.parentDocumentId = args.parent_document_id;
    const r = await api<{ data: OutlineDoc[] }>('/api/documents.list', body);
    const out = (r.data ?? []).map((d) => ({
      id: d.id,
      title: d.title,
      url: d.url,
      parent_id: d.parentDocumentId,
      updated_at: d.updatedAt,
    }));
    return jsonResult({
      collection_id: args.collection_id,
      parent_document_id: args.parent_document_id,
      count: out.length,
      documents: out,
    });
  },
);

await server.connect(new StdioServerTransport());
