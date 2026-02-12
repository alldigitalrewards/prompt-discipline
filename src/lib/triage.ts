/**
 * Smart triage classification system for preflight MCP server.
 * Classifies incoming prompts into categories and returns recommended action.
 *
 * Pure function, no side effects, no external dependencies.
 *
 * Example classifications:
 *   "commit"                                                → trivial
 *   "fix the null check in src/auth/jwt.ts line 42"         → clear
 *   "fix the auth bug"                                      → ambiguous
 *   "add tiered rewards" (with rewards-api related)         → cross-service
 *   "refactor auth to OAuth2 and update all API consumers"  → multi-step
 */

// ── Types ──────────────────────────────────────────────────────────────────

export type TriageLevel =
  | 'trivial'
  | 'clear'
  | 'ambiguous'
  | 'cross-service'
  | 'multi-step';

export interface TriageResult {
  level: TriageLevel;
  confidence: number;        // 0–1
  reasons: string[];
  recommended_tools: string[];
  cross_service_hits?: string[];
}

export interface TriageConfig {
  alwaysCheck?: string[];
  skip?: string[];
  crossServiceKeywords?: string[];
  strictness?: string;       // 'relaxed' | 'standard' | 'strict'
  relatedAliases?: string[];
}

// ── Constants ──────────────────────────────────────────────────────────────

const TRIVIAL_COMMANDS = [
  'commit', 'format', 'lint', 'run tests', 'push', 'pull',
  'status', 'build', 'test', 'deploy', 'start', 'stop', 'restart',
];

const VAGUE_PRONOUNS = /\b(it|them|the thing|those|these)\b/i;

const VAGUE_VERBS = ['fix', 'update', 'change'];

const CROSS_SERVICE_TERMS = [
  'schema', 'contract', 'interface', 'event',
];

const FILE_PATH_RE = /(?:^|[\s,:(])([.\w\-/\\]+\.\w{1,6})\b/;
const LINE_NUMBER_RE = /\bline\s+\d+|:\d+\b/;

const MULTI_STEP_SEQUENTIAL = /\b(then|after that|first\b.*\bthen|finally)\b/i;

// ── Helpers ────────────────────────────────────────────────────────────────

function lower(s: string): string {
  return s.toLowerCase().trim();
}

function isTrivialCommand(prompt: string): boolean {
  const p = lower(prompt);
  return TRIVIAL_COMMANDS.some(
    (cmd) => p === cmd || p.startsWith(cmd + ' '),
  );
}

function hasFileRefs(prompt: string): boolean {
  return FILE_PATH_RE.test(prompt);
}

function hasLineNumbers(prompt: string): boolean {
  return LINE_NUMBER_RE.test(prompt);
}

function hasVaguePronouns(prompt: string): boolean {
  return VAGUE_PRONOUNS.test(prompt);
}

/** Returns true when a vague verb appears without a concrete target after it. */
function hasVagueVerbs(prompt: string): boolean {
  const words = lower(prompt).split(/\s+/);
  return VAGUE_VERBS.some((verb) => {
    const idx = words.indexOf(verb);
    if (idx === -1) return false;
    // Look at the next few words for something concrete
    const tail = words.slice(idx + 1, idx + 4);
    const hasTarget = tail.some(
      (w) => /\.\w+/.test(w) || w.length > 6 || /[A-Z]/.test(w),
    );
    return !hasTarget;
  });
}

function detectCrossService(
  prompt: string,
  config: TriageConfig,
): string[] {
  const p = lower(prompt);
  const hits: string[] = [];

  for (const kw of config.crossServiceKeywords ?? []) {
    if (p.includes(lower(kw))) hits.push(`keyword: ${kw}`);
  }

  for (const alias of config.relatedAliases ?? []) {
    if (p.includes(lower(alias))) hits.push(`project: ${alias}`);
  }

  for (const term of CROSS_SERVICE_TERMS) {
    if (p.includes(term)) hits.push(`term: ${term}`);
  }

  return hits;
}

function isMultiStep(prompt: string): boolean {
  const p = lower(prompt);

  // "and" connecting distinct clauses (heuristic: split and check length)
  if (p.includes(' and ') && p.split(' and ').length > 1) {
    const parts = p.split(' and ');
    // Both sides should be non-trivial (> 2 words each)
    if (parts.every((part) => part.trim().split(/\s+/).length >= 2)) {
      return true;
    }
  }

  // Sequential language
  if (MULTI_STEP_SEQUENTIAL.test(prompt)) return true;

  // Numbered / bulleted lists
  if (/\n\s*[1-9][.)]\s/.test(prompt) || /\n\s*[-*]\s/.test(prompt)) {
    return true;
  }

  // Multiple file refs in different directories
  const files = prompt.match(/[\w\-./\\]+\.\w{1,6}/g) ?? [];
  if (files.length > 1) {
    const dirs = new Set(files.map((f) => f.split('/')[0]));
    if (dirs.size > 1) return true;
  }

  return false;
}

// ── Main ───────────────────────────────────────────────────────────────────

export function triagePrompt(
  prompt: string,
  config?: TriageConfig,
): TriageResult {
  const cfg: TriageConfig = config ?? {};
  const len = prompt.trim().length;
  const reasons: string[] = [];
  const tools: string[] = [];

  // 1. Skip keywords → trivial immediately
  for (const kw of cfg.skip ?? []) {
    if (lower(prompt).includes(lower(kw))) {
      return {
        level: 'trivial',
        confidence: 0.95,
        reasons: [`matches skip keyword: "${kw}"`],
        recommended_tools: [],
      };
    }
  }

  // 2. Multi-step (check early — highest complexity)
  if (isMultiStep(prompt)) {
    reasons.push('contains multi-step indicators');
    tools.push('clarify-intent', 'scope-work', 'sequence-tasks');
    return { level: 'multi-step', confidence: 0.85, reasons, recommended_tools: tools };
  }

  // 3. Cross-service
  const csHits = detectCrossService(prompt, cfg);
  if (csHits.length > 0) {
    reasons.push(`cross-service indicators: ${csHits.join(', ')}`);
    tools.push('clarify-intent', 'scope-work', 'search-related-projects');
    return {
      level: 'cross-service',
      confidence: 0.8,
      reasons,
      recommended_tools: tools,
      cross_service_hits: csHits,
    };
  }

  // 4. always_check keywords → at least ambiguous
  for (const kw of cfg.alwaysCheck ?? []) {
    if (lower(prompt).includes(lower(kw))) {
      reasons.push(`matches always_check keyword: "${kw}"`);
      tools.push('clarify-intent', 'scope-work');
      return { level: 'ambiguous', confidence: 0.8, reasons, recommended_tools: tools };
    }
  }

  // 5. Trivial: short common commands
  if (len < 20 && isTrivialCommand(prompt)) {
    return {
      level: 'trivial',
      confidence: 0.9,
      reasons: ['short common command'],
      recommended_tools: [],
    };
  }

  // 6. Ambiguous signals
  const ambiguousReasons: string[] = [];
  if (len < 50 && !hasFileRefs(prompt)) {
    ambiguousReasons.push('short prompt without file references');
  }
  if (hasVaguePronouns(prompt)) {
    ambiguousReasons.push('contains vague pronouns');
  }
  if (hasVagueVerbs(prompt)) {
    ambiguousReasons.push('contains vague verbs without specific targets');
  }

  if (ambiguousReasons.length > 0) {
    return {
      level: 'ambiguous',
      confidence: 0.7,
      reasons: ambiguousReasons,
      recommended_tools: ['clarify-intent', 'scope-work'],
    };
  }

  // 7. Clear — specific, well-formed prompt
  if (hasFileRefs(prompt)) reasons.push('references specific file paths');
  if (hasLineNumbers(prompt)) reasons.push('references specific line numbers');
  if (len > 50) reasons.push('detailed prompt with concrete nouns');
  if (reasons.length === 0) reasons.push('well-formed prompt with clear intent');

  const clearTools: string[] = hasFileRefs(prompt) ? ['verify-files-exist'] : [];

  // Strictness adjustment
  if (cfg.strictness === 'strict' && clearTools.length === 0) {
    clearTools.push('verify-files-exist');
  }

  return {
    level: 'clear',
    confidence: cfg.strictness === 'strict' ? 0.8 : 0.85,
    reasons,
    recommended_tools: clearTools,
  };
}
