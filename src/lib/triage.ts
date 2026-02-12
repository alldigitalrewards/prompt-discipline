import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import type { TriageLevel, TriageResult, PreflightConfig } from '../types.js';

interface TriageConfig {
  always_check: string[];
  skip: string[];
  cross_service_keywords: string[];
  strictness: 'relaxed' | 'standard' | 'strict';
}

/**
 * Load triage configuration from .preflight/triage.yml or use defaults
 */
function loadTriageConfig(projectRoot?: string): TriageConfig {
  const defaults: TriageConfig = {
    always_check: [],
    skip: [],
    cross_service_keywords: [],
    strictness: 'standard'
  };

  if (!projectRoot) {
    return defaults;
  }

  const configPath = join(projectRoot, '.preflight', 'triage.yml');
  if (!existsSync(configPath)) {
    return defaults;
  }

  try {
    // Simple YAML parsing for the subset we need
    const content = readFileSync(configPath, 'utf-8');
    const config: Partial<TriageConfig> = {};
    
    // Parse arrays
    const parseArray = (key: string): string[] => {
      const match = content.match(new RegExp(`${key}:\\s*\\n((\\s+-\\s+.+\\n?)*)`));
      if (!match) return [];
      return match[1].split('\n').map(line => line.replace(/^\s*-\s+/, '').trim()).filter(Boolean);
    };
    
    // Parse strictness
    const strictnessMatch = content.match(/strictness:\s*([^\n]+)/);
    if (strictnessMatch) {
      const value = strictnessMatch[1].trim().replace(/["']/g, '');
      if (['relaxed', 'standard', 'strict'].includes(value)) {
        config.strictness = value as 'relaxed' | 'standard' | 'strict';
      }
    }

    return {
      always_check: parseArray('always_check'),
      skip: parseArray('skip'),
      cross_service_keywords: parseArray('cross_service_keywords'),
      strictness: config.strictness || defaults.strictness
    };
  } catch (error) {
    // If parsing fails, use defaults
    return defaults;
  }
}

/**
 * Check if prompt contains common command patterns for trivial classification
 */
function isTrivialCommand(prompt: string): boolean {
  const trivialCommands = [
    'commit', 'format', 'lint', 'run tests', 'push', 'pull', 'status',
    'build', 'test', 'deploy', 'start', 'stop', 'restart'
  ];
  
  const normalizedPrompt = prompt.toLowerCase().trim();
  return trivialCommands.some(cmd => normalizedPrompt === cmd || normalizedPrompt.startsWith(cmd + ' '));
}

/**
 * Check if prompt is just a file path
 */
function isFilePath(prompt: string): boolean {
  const trimmed = prompt.trim();
  // Basic file path patterns (with extensions)
  return /^[\w\-./]+\.\w+$/.test(trimmed) || 
         /^[\w\-./\\]+[\/\\][\w\-./\\]+\.\w+$/.test(trimmed);
}

/**
 * Check if prompt references specific file paths with extensions
 */
function hasFileReferences(prompt: string): boolean {
  // Match file paths with extensions like src/auth/jwt.ts, ./config.json, etc.
  return /[\w\-./\\]+\.\w{1,4}(?:\s|$|,|:)/.test(prompt);
}

/**
 * Check if prompt references specific line numbers
 */
function hasLineNumbers(prompt: string): boolean {
  return /line\s+\d+|:\d+|@\d+/.test(prompt);
}

/**
 * Check for vague pronouns that indicate ambiguity
 */
function hasVaguePronouns(prompt: string): boolean {
  const vaguePronouns = /\b(it|them|the thing|that|those|this|these)\b/i;
  return vaguePronouns.test(prompt);
}

/**
 * Check for vague verbs without specific objects
 */
function hasVagueVerbs(prompt: string): boolean {
  const vagueVerbs = ['fix', 'update', 'change', 'refactor', 'improve', 'optimize'];
  const words = prompt.toLowerCase().split(/\s+/);
  
  return vagueVerbs.some(verb => {
    const verbIndex = words.indexOf(verb);
    if (verbIndex === -1) return false;
    
    // Check if verb is followed by a specific target (file name, specific noun)
    const nextWords = words.slice(verbIndex + 1, verbIndex + 4);
    const hasSpecificTarget = nextWords.some(word => 
      /\.\w+/.test(word) || // file extension
      word.length > 6 || // longer words are more likely to be specific
      /[A-Z]/.test(word) // capitalized words (class names, etc.)
    );
    
    return !hasSpecificTarget;
  });
}

/**
 * Check if prompt contains cross-service indicators
 */
function hasCrossServiceIndicators(prompt: string, config: TriageConfig, relatedProjects?: Record<string, string>): string[] {
  const hits: string[] = [];
  const lowerPrompt = prompt.toLowerCase();
  
  // Check config keywords
  config.cross_service_keywords.forEach(keyword => {
    if (lowerPrompt.includes(keyword.toLowerCase())) {
      hits.push(`keyword: ${keyword}`);
    }
  });
  
  // Check related project aliases
  if (relatedProjects) {
    Object.keys(relatedProjects).forEach(alias => {
      if (lowerPrompt.includes(alias.toLowerCase())) {
        hits.push(`project: ${alias}`);
      }
    });
  }
  
  // Check common cross-service terms
  const crossServiceTerms = ['schema', 'contract', 'interface', 'event', 'api', 'endpoint', 'service'];
  crossServiceTerms.forEach(term => {
    if (lowerPrompt.includes(term)) {
      hits.push(`term: ${term}`);
    }
  });
  
  return hits;
}

/**
 * Check if prompt indicates multi-step work
 */
function isMultiStep(prompt: string): boolean {
  // Check for "and" connecting distinct tasks
  if (/\band\b/.test(prompt) && prompt.split(' and ').length > 1) {
    return true;
  }
  
  // Check for numbered/bulleted lists in the prompt itself
  if (/^\s*[1-9]\.|^\s*[-*]/.test(prompt) || prompt.includes('\n1.') || prompt.includes('\n-')) {
    return true;
  }
  
  // Check for sequential words
  const sequentialWords = ['then', 'after that', 'first', 'second', 'next', 'finally'];
  const hasSequential = sequentialWords.some(word => prompt.toLowerCase().includes(word));
  if (hasSequential) return true;
  
  // Check for multiple file references in different directories
  const fileMatches = prompt.match(/[\w\-./\\]+\.\w+/g) || [];
  if (fileMatches.length > 1) {
    const directories = fileMatches.map(file => file.split('/')[0]).filter((dir, i, arr) => arr.indexOf(dir) === i);
    return directories.length > 1;
  }
  
  return false;
}

/**
 * Classify a prompt into triage levels and return recommendations
 */
export function triagePrompt(prompt: string, config?: PreflightConfig): TriageResult {
  const triageConfig = loadTriageConfig();
  const reasons: string[] = [];
  const recommended_tools: string[] = [];
  let confidence = 0.8; // Default confidence
  
  const promptLength = prompt.trim().length;
  
  // Apply config overrides first
  if (config?.triage) {
    Object.assign(triageConfig, config.triage);
  }
  
  // Check skip keywords first (highest priority)
  const skipMatch = triageConfig.skip.find(keyword => 
    prompt.toLowerCase().includes(keyword.toLowerCase())
  );
  if (skipMatch) {
    reasons.push(`matches skip keyword: ${skipMatch}`);
    return {
      level: 'trivial',
      confidence: 0.9,
      reasons,
      recommended_tools: []
    };
  }
  
  // Check always_check keywords (force ambiguous+)
  const alwaysCheckMatch = triageConfig.always_check.find(keyword => 
    prompt.toLowerCase().includes(keyword.toLowerCase())
  );
  if (alwaysCheckMatch) {
    reasons.push(`matches always_check keyword: ${alwaysCheckMatch}`);
    recommended_tools.push('clarify-intent', 'scope-work');
    
    // Still need to check if it's cross-service or multi-step
    const crossServiceHits = hasCrossServiceIndicators(prompt, triageConfig, config?.related_projects);
    if (crossServiceHits.length > 0) {
      reasons.push(`cross-service indicators: ${crossServiceHits.join(', ')}`);
      recommended_tools.push('search-related-projects');
      return {
        level: 'cross-service',
        confidence: 0.8,
        reasons,
        recommended_tools,
        cross_service_hits: crossServiceHits
      };
    }
    
    if (isMultiStep(prompt)) {
      reasons.push('contains multi-step indicators');
      recommended_tools.push('sequence-tasks');
      return {
        level: 'multi-step',
        confidence: 0.8,
        reasons,
        recommended_tools
      };
    }
    
    return {
      level: 'ambiguous',
      confidence: 0.8,
      reasons,
      recommended_tools
    };
  }
  
  // Multi-step check (highest complexity)
  if (isMultiStep(prompt)) {
    reasons.push('contains multi-step indicators');
    recommended_tools.push('clarify-intent', 'scope-work', 'sequence-tasks');
    return {
      level: 'multi-step',
      confidence: 0.85,
      reasons,
      recommended_tools
    };
  }
  
  // Cross-service check
  const crossServiceHits = hasCrossServiceIndicators(prompt, triageConfig, config?.related_projects);
  if (crossServiceHits.length > 0) {
    reasons.push(`cross-service indicators: ${crossServiceHits.join(', ')}`);
    recommended_tools.push('clarify-intent', 'scope-work', 'search-related-projects');
    return {
      level: 'cross-service',
      confidence: 0.8,
      reasons,
      recommended_tools,
      cross_service_hits: crossServiceHits
    };
  }
  
  // Trivial checks
  if (promptLength < 20 && isTrivialCommand(prompt)) {
    reasons.push('short common command');
    return {
      level: 'trivial',
      confidence: 0.9,
      reasons,
      recommended_tools: []
    };
  }
  
  if (isFilePath(prompt)) {
    reasons.push('appears to be a file path');
    return {
      level: 'trivial',
      confidence: 0.85,
      reasons,
      recommended_tools: []
    };
  }
  
  // Ambiguous checks
  if (promptLength < 50 && !hasFileReferences(prompt)) {
    reasons.push('short prompt without file references');
    confidence = 0.7;
  }
  
  if (hasVaguePronouns(prompt)) {
    reasons.push('contains vague pronouns');
    confidence = Math.min(confidence, 0.8);
  }
  
  if (hasVagueVerbs(prompt)) {
    reasons.push('contains vague verbs without specific targets');
    confidence = Math.min(confidence, 0.75);
  }
  
  if (reasons.length > 0) {
    recommended_tools.push('clarify-intent', 'scope-work');
    return {
      level: 'ambiguous',
      confidence,
      reasons,
      recommended_tools
    };
  }
  
  // Clear classification (default for specific, well-formed prompts)
  if (hasFileReferences(prompt)) {
    reasons.push('references specific file paths');
    recommended_tools.push('verify-files-exist');
  }
  
  if (hasLineNumbers(prompt)) {
    reasons.push('references specific line numbers');
  }
  
  if (promptLength > 50) {
    reasons.push('detailed prompt with concrete nouns');
  }
  
  // Apply strictness adjustment
  if (triageConfig.strictness === 'strict' && recommended_tools.length === 0) {
    reasons.push('strict mode: adding verification checks');
    recommended_tools.push('verify-files-exist');
    confidence = Math.min(confidence, 0.8);
  } else if (triageConfig.strictness === 'relaxed' && reasons.length === 0) {
    reasons.push('relaxed mode: assuming clear intent');
    confidence = Math.min(confidence, 0.9);
  }
  
  if (reasons.length === 0) {
    reasons.push('well-formed prompt with clear intent');
  }
  
  return {
    level: 'clear',
    confidence,
    reasons,
    recommended_tools
  };
}

/* 
Example test cases and expected classifications:

"commit" → trivial
  - Short common command, < 20 chars
  - reasons: ["short common command"]
  - recommended_tools: []

"fix the null check in src/auth/jwt.ts line 42" → clear
  - Has file reference and line number
  - reasons: ["references specific file paths", "references specific line numbers"]  
  - recommended_tools: ["verify-files-exist"]

"fix the auth bug" → ambiguous  
  - Vague verb without specific target, no file references
  - reasons: ["contains vague verbs without specific targets"]
  - recommended_tools: ["clarify-intent", "scope-work"]

"add tiered rewards" (with rewards-api as related project) → cross-service
  - Would match if "rewards" is in related_projects or cross_service_keywords
  - reasons: ["cross-service indicators: project: rewards-api"]
  - recommended_tools: ["clarify-intent", "scope-work", "search-related-projects"]
  - cross_service_hits: ["project: rewards-api"]

"refactor auth to OAuth2 and update all API consumers" → multi-step
  - Contains "and" connecting distinct tasks, mentions multiple components
  - reasons: ["contains multi-step indicators"]
  - recommended_tools: ["clarify-intent", "scope-work", "sequence-tasks"]

"src/components/Button.tsx" → trivial
  - Just a file path
  - reasons: ["appears to be a file path"]
  - recommended_tools: []

"update it" → ambiguous
  - Short prompt, vague pronoun, vague verb
  - reasons: ["short prompt without file references", "contains vague pronouns", "contains vague verbs without specific targets"]
  - recommended_tools: ["clarify-intent", "scope-work"]

"implement user authentication with JWT tokens in the auth service" → clear
  - Detailed prompt > 50 chars with concrete nouns
  - reasons: ["detailed prompt with concrete nouns"]
  - recommended_tools: []

"fix schema and update contract" (with cross_service_keywords: ["schema", "contract"]) → cross-service  
  - Contains cross-service keywords
  - reasons: ["cross-service indicators: keyword: schema, keyword: contract"]
  - recommended_tools: ["clarify-intent", "scope-work", "search-related-projects"]
  - cross_service_hits: ["keyword: schema", "keyword: contract"]

"first update the database schema, then migrate the data, and finally update the API" → multi-step
  - Contains sequential words and multiple distinct tasks
  - reasons: ["contains multi-step indicators"] 
  - recommended_tools: ["clarify-intent", "scope-work", "sequence-tasks"]
*/