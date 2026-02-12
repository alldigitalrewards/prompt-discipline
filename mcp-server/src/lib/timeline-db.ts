import * as lancedb from "@lancedb/lancedb";
import { randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, basename } from "node:path";
import { createEmbeddingProvider, type EmbeddingProvider, type EmbeddingConfig } from "./embeddings.js";

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

const BASE_DIR = join(homedir(), ".prompt-discipline");
const DB_PATH = join(BASE_DIR, "timeline.lance");
const CONFIG_PATH = join(BASE_DIR, "config.json");

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
  await mkdir(BASE_DIR, { recursive: true });
  await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2));
}

// --- Database Manager ---

let _db: lancedb.Connection | null = null;
let _embedder: EmbeddingProvider | null = null;

export async function getDb(): Promise<lancedb.Connection> {
  if (!_db) {
    await mkdir(BASE_DIR, { recursive: true });
    _db = await lancedb.connect(DB_PATH);
  }
  return _db;
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

export async function getEventsTable(): Promise<lancedb.Table> {
  const db = await getDb();
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

export async function insertEvents(events: TimelineEvent[]): Promise<void> {
  if (events.length === 0) return;

  const embedder = await getEmbedder();
  const table = await getEventsTable();

  const contents = events.map((e) => e.content);
  const vectors = await embedder.embedBatch(contents);

  const records = events.map((e, i) => ({
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

  // Update config with project info
  const config = await loadConfig();
  for (const r of records) {
    if (!r.project) continue;
    if (!config.indexed_projects[r.project]) {
      config.indexed_projects[r.project] = {
        last_session_index: r.timestamp,
        last_git_index: "1970-01-01T00:00:00Z",
        event_count: 0,
      };
    }
    config.indexed_projects[r.project].event_count += 1;
  }
  await saveConfig(config);
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

export async function searchSemantic(
  query: string,
  opts: SearchOptions = {},
): Promise<TimelineRecord[]> {
  const embedder = await getEmbedder();
  const table = await getEventsTable();
  const queryVector = await embedder.embed(query);
  const limit = opts.limit || 20;

  let search = table.search(queryVector).limit(limit);
  const where = buildWhereFilter(opts);
  if (where) search = search.where(where);

  const results = await search.toArray();
  return results as unknown as TimelineRecord[];
}

export async function searchExact(
  query: string,
  opts: SearchOptions = {},
): Promise<TimelineRecord[]> {
  const table = await getEventsTable();
  const limit = opts.limit || 50;
  const likeClauses = [`content LIKE '%${query.replace(/'/g, "''")}%'`];
  const where = buildWhereFilter(opts);
  const fullWhere = where ? `${likeClauses[0]} AND ${where}` : likeClauses[0];

  const results = await table.query().where(fullWhere).limit(limit).toArray();
  return results as unknown as TimelineRecord[];
}

export async function getTimeline(
  opts: SearchOptions = {},
): Promise<TimelineRecord[]> {
  const table = await getEventsTable();
  const limit = opts.limit || 100;
  const where = buildWhereFilter(opts);

  let q = table.query().limit(limit);
  if (where) q = q.where(where);

  const results = await q.toArray();
  // Sort chronologically
  results.sort((a: any, b: any) =>
    a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0
  );
  return results as unknown as TimelineRecord[];
}

export async function getIndexedProjects(): Promise<ProjectInfo[]> {
  const config = await loadConfig();
  return Object.entries(config.indexed_projects).map(([project, info]) => ({
    project,
    project_name: basename(project),
    event_count: info.event_count,
    last_session_index: info.last_session_index,
    last_git_index: info.last_git_index,
  }));
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
