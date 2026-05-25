import { existsSync, readFileSync } from 'node:fs';
import { llmModel } from './client.js';

interface PromptVars {
  date?: string;
  user?: string;
  persona?: string;
  memory?: string;
  tools?: string;
  org_context?: string;
  model?: string;
}

const TEMPLATE_PATH = 'prompts/system.md';
const PERSONA_PATH = 'config/persona.md';
const ORG_CONTEXT_PATH = 'config/org-context.md';

let templateCache: string | null = null;
let personaCache: string | null = null;
let orgContextCache: string | null = null;

function loadTemplate(): string {
  if (templateCache !== null) return templateCache;
  templateCache = readFileSync(TEMPLATE_PATH, 'utf-8');
  return templateCache;
}

function loadPersona(): string {
  if (personaCache !== null) return personaCache;
  personaCache = existsSync(PERSONA_PATH) ? readFileSync(PERSONA_PATH, 'utf-8') : '';
  return personaCache;
}

function loadOrgContext(): string {
  if (orgContextCache !== null) return orgContextCache;
  if (!existsSync(ORG_CONTEXT_PATH)) {
    orgContextCache = '';
    return orgContextCache;
  }
  // Strip HTML comments + the boilerplate header so empty templates don't
  // bloat every prompt with placeholder text.
  const raw = readFileSync(ORG_CONTEXT_PATH, 'utf-8');
  orgContextCache = raw.replace(/<!--[\s\S]*?-->/g, '').trim();
  return orgContextCache;
}

/** Clears cached file reads — useful for hot-reload after editing config. */
export function resetPromptCache(): void {
  templateCache = null;
  personaCache = null;
  orgContextCache = null;
}

export function renderSystemPrompt(vars: PromptVars = {}): string {
  const template = loadTemplate();
  const filled = {
    date: vars.date ?? new Date().toISOString().slice(0, 10),
    user: vars.user ?? 'unknown',
    persona: vars.persona ?? loadPersona(),
    org_context: vars.org_context ?? loadOrgContext(),
    memory: vars.memory ?? '(memory not wired yet — M3)',
    tools: vars.tools ?? '(tools not wired yet — M4/M5)',
    model: vars.model ?? llmModel,
  };
  return template
    .replace(/\{\{date\}\}/g, filled.date)
    .replace(/\{\{user\}\}/g, filled.user)
    .replace(/\{\{persona\}\}/g, filled.persona)
    .replace(/\{\{org_context\}\}/g, filled.org_context)
    .replace(/\{\{memory\}\}/g, filled.memory)
    .replace(/\{\{tools\}\}/g, filled.tools)
    .replace(/\{\{model\}\}/g, filled.model);
}

export const PROMPT_VERSION = 'v2';
