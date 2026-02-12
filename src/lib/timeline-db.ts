import * as lancedb from "@lancedb/lancedb";
import { randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, basename, resolve } from "node:path";
import { createEmbeddingProvider, type EmbeddingProvider, type EmbeddingConfig } from "./embeddings.js";
import type { ProjectMeta, ProjectRegistry, SearchScope } from "../types.js";

// --- Types ---

export const EVENT_TYPES = [
  "prompt", "assistant", "correction", "commit",
  "tool_call", "compaction", "sub_agent_spawn", "error",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export interface TimelineEvent {
  id?: string;
  timestamp: string;
  type: EventType;
  project: string;
  project_name?: string;
  branch: string;
  session_id: string;
  source_file: string;
  source_line: number;
  content: string;
  content_preview?: string;
  vector?: number[];
  metadata?: string;
}

export interface TimelineRecord extends Required<TimelineEvent> {}

export interface SearchOptions {
  project_dirs?: string[];
  project?: string;
  branch?: string;
  type?: EventType;
  since?: string;
  until?: string;
  limit?: number;
  offset?: number;
}

export interface ProjectInfo {
  project: string;
  project_name: string;
  hash: string;
  event_count: number;
  last_session_index?: string;
  last_git_index?: string;
}

export interface TimelineConfig {
  embedding_provider: "local" | "openai";
  embedding_model: string;
  openai_api_key?: string;
  indexed_projects: Record<string, {
    last_session_index: string;
    last_git_index: string;
    event_count: number;
  }>;
}

// --- Paths ---

const PREFLIGHT_DIR = join(homedir(), ".preflight");
const PROJECTS_DIR = join(PREFLIGHT_DIR, "projects");
const CONFIG_PATH = join(PREFLIGHT_DIR, "config.json");
const INDEX_PATH = join(PROJECTS_DIR, "index.json");

// --- Utilities ---

/** Create deterministic hash for project directory */
function hashProjectDir(projectDir: string): string {
  const absolutePath = resolve(projectDir);
  return createHash("sha256").update(absolutePath).digest("hex").slice(0, 12);
}

/** Get paths for a project's data */
function getProjectPaths(projectDir: string) {
  const hash = hashProjectDir(projectDir);
  const projectBase = join(PROJECTS_DIR, hash);
  return {
    hash,
    projectDir: projectBase,
    dbPath: join(projectBase, "timeline.lance"),
    metaPath: join(projectBase, "meta.json"),
  };
}

// --- Config ---

const DEFAULT_CONFIG: TimelineConfig = {
  embedding_provider: "local",
  embedding_model: "Xenova/all-MiniLM-L6-v2",
  indexed_projects: {},
};

export async function loadConfig(): Promise<TimelineConfig> {
  try {
    const raw = await readFile(CONFIG_PATH, "utf-8");
    return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export async function saveConfig(config: TimelineConfig): Promise<void> {
  await mkdir(PREFLIGHT_DIR, { recursive: true });
  await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2));
}

// --- Project Registry ---

export async function loadProjectRegistry(): Promise<ProjectRegistry> {
  try {
    const raw = await readFile(INDEX_PATH, "utf-8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export async function saveProjectRegistry(registry: ProjectRegistry): Promise<void> {
  await mkdir(PROJECTS_DIR, { recursive: true });
  await writeFile(INDEX_PATH, JSON.stringify(registry, null, 2));
}

export async function registerProject(projectDir: string): Promise<void> {
  const absoluteDir = resolve(projectDir);
  const registry = await loadProjectRegistry();
  const { hash } = getProjectPaths(absoluteDir);
  
  if (!registry[absoluteDir]) {
    registry[absoluteDir] = {
      hash,
      onboarded_at: new Date().toISOString(),
    };
    await saveProjectRegistry(registry);
  }
}

// --- Project Metadata ---

export async function loadProjectMeta(projectDir: string): Promise<ProjectMeta | null> {
  const { metaPath } = getProjectPaths(projectDir);
  try {
    const raw = await readFile(metaPath, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function saveProjectMeta(projectDir: string, meta: ProjectMeta): Promise<void> {
  const { projectDir: projectBase, metaPath } = getProjectPaths(projectDir);
  await mkdir(projectBase, { recursive: true });
  await writeFile(metaPath, JSON.stringify(meta, null, 2));
}

// --- Database Manager ---

const _connections = new Map<string, lancedb.Connection>();
let _embedder: EmbeddingProvider | null = null;

export async function getDb(projectDir: string): Promise<lancedb.Connection> {
  const absoluteDir = resolve(projectDir);
  const { dbPath } = getProjectPaths(absoluteDir);
  
  if (!_connections.has(absoluteDir)) {
    await mkdir(PROJECTS_DIR, { recursive: true });
    const db = await lancedb.connect(dbPath);
    _connections.set(absoluteDir, db);
  }
  
  return _connections.get(absoluteDir)!;
}

async function getEmbedder(): Promise<EmbeddingProvider> {
  if (!_embedder) {
    const config = await loadConfig();
    _embedder = createEmbeddingProvider({
      provider: config.embedding_provider,
      apiKey: config.openai_api_key,
    });
  }
  return _embedder;
}

export async function getEventsTable(projectDir: string): Promise<lancedb.Table> {
  const db = await getDb(projectDir);
  try {
    return await db.openTable("events");
  } catch {
    // Create with a seed record then delete it — LanceDB needs data to infer schema
    const embedder = await getEmbedder();
    const zeroVector = new Array(embedder.dimensions).fill(0);
    const seed = [{
      id: "__seed__",
      timestamp: new Date().toISOString(),
      type: "prompt",
      project: "",
      project_name: "",
      branch: "",
      session_id: "",
      source_file: "",
      source_line: 0,
      content: "",
      content_preview: "",
      vector: zeroVector,
      metadata: "{}",
    }];
    const table = await db.createTable("events", seed);
    await table.delete('id = "__seed__"');
    return table;
  }
}

// --- Core Operations ---

export async function insertEvents(events: TimelineEvent[], projectDir?: string): Promise<void> {
  if (events.length === 0) return;

  // Group events by project if no specific projectDir provided
  const eventsByProject = new Map<string, TimelineEvent[]>();
  
  for (const event of events) {
    const targetProject = projectDir || event.project;
    if (!targetProject) throw new Error("Event must have project or projectDir must be specified");
    
    if (!eventsByProject.has(targetProject)) {
      eventsByProject.set(targetProject, []);
    }
    eventsByProject.get(targetProject)!.push({ ...event, project: targetProject });
  }

  const embedder = await getEmbedder();

  for (const [proj, projEvents] of eventsByProject) {
    const table = await getEventsTable(proj);
    
    const contents = projEvents.map((e) => e.content);
    const vectors = await embedder.embedBatch(contents);

    const records = projEvents.map((e, i) => ({
      id: e.id || randomUUID(),
      timestamp: e.timestamp,
      type: e.type,
      project: e.project,
      project_name: e.project_name || basename(e.project),
      branch: e.branch,
      session_id: e.session_id,
      source_file: e.source_file,
      source_line: e.source_line,
      content: e.content,
      content_preview: e.content_preview || e.content.slice(0, 200),
      vector: vectors[i],
      metadata: e.metadata || "{}",
    }));

    await table.add(records);

    // Update project metadata
    await registerProject(proj);
    const meta = await loadProjectMeta(proj) || {
      project_dir: resolve(proj),
      onboarded_at: new Date().toISOString(),
      event_count: 0,
    };
    meta.event_count += records.length;
    await saveProjectMeta(proj, meta);

    // Update legacy config for backward compatibility
    const config = await loadConfig();
    if (!config.indexed_projects[proj]) {
      config.indexed_projects[proj] = {
        last_session_index: records[records.length - 1].timestamp,
        last_git_index: "1970-01-01T00:00:00Z",
        event_count: meta.event_count,
      };
    } else {
      config.indexed_projects[proj].event_count += records.length;
    }
    await saveConfig(config);
  }
}

function buildWhereFilter(opts: SearchOptions): string | undefined {
  const clauses: string[] = [];
  if (opts.project) clauses.push(`project = '${opts.project}'`);
  if (opts.branch) clauses.push(`branch = '${opts.branch}'`);
  if (opts.type) clauses.push(`type = '${opts.type}'`);
  if (opts.since) clauses.push(`timestamp >= '${opts.since}'`);
  if (opts.until) clauses.push(`timestamp <= '${opts.until}'`);
  return clauses.length > 0 ? clauses.join(" AND ") : undefined;
}

/** Search across multiple projects and merge results by score */
export async function searchSemantic(
  query: string,
  opts: SearchOptions = {},
): Promise<TimelineRecord[]> {
  const embedder = await getEmbedder();
  const queryVector = await embedder.embed(query);
  const limit = opts.limit || 20;

  // Determine which projects to search
  let projectsToSearch = opts.project_dirs || [];
  if (projectsToSearch.length === 0 && opts.project) {
    projectsToSearch = [opts.project];
  }
  if (projectsToSearch.length === 0) {
    // Default to current project if available
    if (process.env.CLAUDE_PROJECT_DIR) {
      projectsToSearch = [process.env.CLAUDE_PROJECT_DIR];
    } else {
      // Fall back to all indexed projects
      const registry = await loadProjectRegistry();
      projectsToSearch = Object.keys(registry);
    }
  }

  const allResults: Array<TimelineRecord & { _score: number }> = [];

  // Search each project
  for (const projectDir of projectsToSearch) {
    try {
      const table = await getEventsTable(projectDir);
      let search = table.search(queryVector).limit(limit * 2); // Over-fetch to allow for filtering
      
      const where = buildWhereFilter(opts);
      if (where) search = search.where(where);

      const results = await search.toArray();
      for (const result of results) {
        allResults.push({
          ...(result as unknown as TimelineRecord),
          _score: 1 - (result._distance || 0),
        });
      }
    } catch (error) {
      // Skip projects that don't exist or have issues
      continue;
    }
  }

  // Sort by score and take top results
  allResults.sort((a, b) => b._score - a._score);
  return allResults.slice(0, limit);
}

export async function searchExact(
  query: string,
  opts: SearchOptions = {},
): Promise<TimelineRecord[]> {
  const limit = opts.limit || 50;
  const likeClauses = [`content LIKE '%${query.replace(/'/g, "''")}%'`];
  const where = buildWhereFilter(opts);
  const fullWhere = where ? `${likeClauses[0]} AND ${where}` : likeClauses[0];

  // Determine which projects to search
  let projectsToSearch = opts.project_dirs || [];
  if (projectsToSearch.length === 0 && opts.project) {
    projectsToSearch = [opts.project];
  }
  if (projectsToSearch.length === 0) {
    if (process.env.CLAUDE_PROJECT_DIR) {
      projectsToSearch = [process.env.CLAUDE_PROJECT_DIR];
    } else {
      const registry = await loadProjectRegistry();
      projectsToSearch = Object.keys(registry);
    }
  }

  const allResults: TimelineRecord[] = [];

  for (const projectDir of projectsToSearch) {
    try {
      const table = await getEventsTable(projectDir);
      const results = await table.query().where(fullWhere).limit(limit).toArray();
      allResults.push(...(results as unknown as TimelineRecord[]));
    } catch {
      continue;
    }
  }

  return allResults.slice(0, limit);
}

export async function getTimeline(
  opts: SearchOptions = {},
): Promise<TimelineRecord[]> {
  const limit = opts.limit || 100;
  const where = buildWhereFilter(opts);

  // Determine which projects to search
  let projectsToSearch = opts.project_dirs || [];
  if (projectsToSearch.length === 0 && opts.project) {
    projectsToSearch = [opts.project];
  }
  if (projectsToSearch.length === 0) {
    if (process.env.CLAUDE_PROJECT_DIR) {
      projectsToSearch = [process.env.CLAUDE_PROJECT_DIR];
    } else {
      const registry = await loadProjectRegistry();
      projectsToSearch = Object.keys(registry);
    }
  }

  const allResults: TimelineRecord[] = [];

  for (const projectDir of projectsToSearch) {
    try {
      const table = await getEventsTable(projectDir);
      let q = table.query().limit(limit);
      if (where) q = q.where(where);

      const results = await q.toArray();
      allResults.push(...(results as unknown as TimelineRecord[]));
    } catch {
      continue;
    }
  }

  // Sort chronologically
  allResults.sort((a, b) =>
    a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0
  );
  
  return allResults.slice(0, limit);
}

export async function listIndexedProjects(): Promise<ProjectInfo[]> {
  const registry = await loadProjectRegistry();
  const projects: ProjectInfo[] = [];

  for (const [projectPath, entry] of Object.entries(registry)) {
    const meta = await loadProjectMeta(projectPath);
    projects.push({
      project: projectPath,
      project_name: basename(projectPath),
      hash: entry.hash,
      event_count: meta?.event_count || 0,
      last_session_index: undefined,
      last_git_index: undefined,
    });
  }

  return projects;
}

// Legacy compatibility functions
export async function getIndexedProjects(): Promise<ProjectInfo[]> {
  return listIndexedProjects();
}

export async function getLastIndexedTimestamp(
  project: string,
  source: "session" | "git",
): Promise<string | null> {
  const config = await loadConfig();
  const info = config.indexed_projects[project];
  if (!info) return null;
  return source === "session" ? info.last_session_index : info.last_git_index;
}

export async function updateLastIndexedTimestamp(
  project: string,
  source: "session" | "git",
  timestamp: string,
): Promise<void> {
  const config = await loadConfig();
  if (!config.indexed_projects[project]) {
    config.indexed_projects[project] = {
      last_session_index: "1970-01-01T00:00:00Z",
      last_git_index: "1970-01-01T00:00:00Z",
      event_count: 0,
    };
  }
  if (source === "session") {
    config.indexed_projects[project].last_session_index = timestamp;
  } else {
    config.indexed_projects[project].last_git_index = timestamp;
  }
  await saveConfig(config);
}