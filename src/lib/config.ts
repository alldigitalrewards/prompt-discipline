// =============================================================================
// Preflight Configuration System
// =============================================================================
// Loads configuration from .preflight/ directory if present,
// falls back to environment variables.
// =============================================================================

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { load as yamlLoad } from "js-yaml";
import { PROJECT_DIR } from "./files.js";

export type Profile = "minimal" | "standard" | "full";
export type EmbeddingProvider = "local" | "openai";
export type TriageStrictness = "relaxed" | "standard" | "strict";

export interface RelatedProject {
  path: string;
  alias: string;
}

export interface PreflightConfig {
  profile: Profile;
  related_projects: RelatedProject[];
  thresholds: {
    session_stale_minutes: number;
    max_tool_calls_before_checkpoint: number;
    correction_pattern_threshold: number;
  };
  embeddings: {
    provider: EmbeddingProvider;
    openai_api_key?: string;
  };
  triage: {
    rules: {
      always_check: string[];
      skip: string[];
      cross_service_keywords: string[];
    };
    strictness: TriageStrictness;
  };
}

// Default configuration (env var fallback)
const DEFAULT_CONFIG: PreflightConfig = {
  profile: "standard",
  related_projects: [],
  thresholds: {
    session_stale_minutes: 30,
    max_tool_calls_before_checkpoint: 100,
    correction_pattern_threshold: 3,
  },
  embeddings: {
    provider: "local",
  },
  triage: {
    rules: {
      always_check: ["rewards", "permissions", "migration", "schema"],
      skip: ["commit", "format", "lint"],
      cross_service_keywords: ["auth", "notification", "event", "webhook"],
    },
    strictness: "standard",
  },
};

let _config: PreflightConfig | null = null;

/** Load config from .preflight/ directory or fall back to env vars */
function loadConfig(): PreflightConfig {
  const preflightDir = join(PROJECT_DIR, ".preflight");
  const configPath = join(preflightDir, "config.yml");
  const triagePath = join(preflightDir, "triage.yml");

  // Start with defaults
  let config: PreflightConfig = JSON.parse(JSON.stringify(DEFAULT_CONFIG));

  // Load .preflight/config.yml if it exists
  if (existsSync(configPath)) {
    try {
      const configYaml = readFileSync(configPath, "utf-8");
      const configData = yamlLoad(configYaml) as any;
      
      if (configData) {
        // Merge config data with defaults
        if (configData.profile) config.profile = configData.profile;
        if (configData.related_projects) config.related_projects = configData.related_projects;
        if (configData.thresholds) config.thresholds = { ...config.thresholds, ...configData.thresholds };
        if (configData.embeddings) config.embeddings = { ...config.embeddings, ...configData.embeddings };
      }
    } catch (error) {
      console.warn(`preflight: warning - failed to parse .preflight/config.yml: ${error}`);
    }
  }

  // Load .preflight/triage.yml if it exists
  if (existsSync(triagePath)) {
    try {
      const triageYaml = readFileSync(triagePath, "utf-8");
      const triageData = yamlLoad(triageYaml) as any;
      
      if (triageData) {
        if (triageData.rules) config.triage.rules = { ...config.triage.rules, ...triageData.rules };
        if (triageData.strictness) config.triage.strictness = triageData.strictness;
      }
    } catch (error) {
      console.warn(`preflight: warning - failed to parse .preflight/triage.yml: ${error}`);
    }
  }

  // Apply environment variable overrides (env vars are fallback, .preflight/ takes precedence)
  // Only use env vars if .preflight/ directory doesn't exist
  if (!existsSync(preflightDir)) {
    // Profile
    const envProfile = process.env.PROMPT_DISCIPLINE_PROFILE?.toLowerCase();
    if (envProfile === "minimal" || envProfile === "standard" || envProfile === "full") {
      config.profile = envProfile;
    }

    // Related projects
    const envRelated = process.env.PREFLIGHT_RELATED;
    if (envRelated) {
      const projects = envRelated.split(",").map(p => p.trim()).filter(Boolean);
      config.related_projects = projects.map(path => ({ path, alias: path.split("/").pop() || path }));
    }

    // Embedding provider
    const envProvider = process.env.EMBEDDING_PROVIDER?.toLowerCase();
    if (envProvider === "local" || envProvider === "openai") {
      config.embeddings.provider = envProvider;
    }

    // OpenAI API key
    if (process.env.OPENAI_API_KEY) {
      config.embeddings.openai_api_key = process.env.OPENAI_API_KEY;
    }
  }

  return config;
}

/** Get the singleton configuration object */
export function getConfig(): PreflightConfig {
  if (_config === null) {
    _config = loadConfig();
  }
  return _config;
}

/** Get related projects as simple path array (backward compatibility) */
export function getRelatedProjects(): string[] {
  return getConfig().related_projects.map(p => p.path);
}

/** Check if .preflight/ directory exists */
export function hasPreflightConfig(): boolean {
  return existsSync(join(PROJECT_DIR, ".preflight"));
}