// CATEGORY 6: sequence_tasks — Sequencing
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { run } from "../lib/git.js";
import { now } from "../lib/state.js";
import { PROJECT_DIR } from "../lib/files.js";
import { existsSync } from "fs";
import { join, resolve } from "path";

type Cat = "schema" | "config" | "api" | "ui" | "test" | "other";

const CATEGORIES: Record<Exclude<Cat, "other">, RegExp> = {
  schema: /\b(schema|migrat|database|db|table|column|index|alter|foreign.?key)\b/i,
  config: /\b(config|env|\.env|settings|secrets?|dotenv|yaml|toml)\b/i,
  api:    /\b(api|route|endpoint|controller|handler|middleware|graphql|rest|rpc)\b/i,
  ui:     /\b(ui|component|page|view|layout|template|css|style|frontend|react|vue|svelte)\b/i,
  test:   /\b(test|spec|e2e|cypress|playwright|jest|vitest|assert|fixture)\b/i,
};

const CAT_DIR_MAP: Record<string, string> = {
  schema: "db/", config: "config/", api: "api/", ui: "src/", test: "test/", other: "src/",
};

// Dependency order: earlier items must complete before later ones
const DEP_ORDER: Cat[] = ["config", "schema", "api", "ui", "test", "other"];

function classify(task: string): Cat[] {
  const cats = (Object.entries(CATEGORIES) as [Exclude<Cat, "other">, RegExp][])
    .filter(([, re]) => re.test(task))
    .map(([k]) => k as Cat);
  // Default to "other" instead of "ui" to avoid misclassifying unrelated tasks
  return cats.length > 0 ? cats : ["other"];
}

function riskScore(cats: Cat[]): number {
  let s = 0;
  if (cats.includes("schema")) s += 10;
  if (cats.includes("config")) s += 7;
  if (cats.includes("api")) s += 4;
  if (cats.includes("ui")) s += 2;
  if (cats.includes("test")) s += 1;
  if (cats.includes("other")) s += 3;
  return s;
}

/** Validate a path is within PROJECT_DIR */
function isSafePath(dir: string): boolean {
  const resolved = resolve(PROJECT_DIR, dir);
  return resolved.startsWith(resolve(PROJECT_DIR) + "/") || resolved === resolve(PROJECT_DIR);
}

/** Detect circular dependencies among categorized tasks */
function detectCircularDeps(tasks: { task: string; cats: Cat[] }[]): string[] {
  const warnings: string[] = [];
  // Simple heuristic: if a task mentions output of another task, flag it
  // More importantly, check if dependency order would create contradictions
  const catSets = tasks.map((t) => new Set(t.cats));
  for (let i = 0; i < tasks.length; i++) {
    for (let j = i + 1; j < tasks.length; j++) {
      const iCats = catSets[i];
      const jCats = catSets[j];
      // Check if i should come before j AND j before i
      const iBeforeJ = [...iCats].some((c) => [...jCats].some((d) => DEP_ORDER.indexOf(c) < DEP_ORDER.indexOf(d)));
      const jBeforeI = [...jCats].some((c) => [...iCats].some((d) => DEP_ORDER.indexOf(c) < DEP_ORDER.indexOf(d)));
      if (iBeforeJ && jBeforeI) {
        warnings.push(`⚠️ Potential circular dependency: "${tasks[i].task.slice(0, 50)}" and "${tasks[j].task.slice(0, 50)}" have cross-layer categories — consider splitting.`);
      }
    }
  }
  return warnings;
}

export function registerSequenceTasks(server: McpServer): void {
  server.tool(
    "sequence_tasks",
    `Order a set of tasks to minimize context switches, reduce re-reads, and batch related work. Supports dependency-order, file-locality, and risk-first strategies. Call when you have multiple tasks to execute in a session.`,
    {
      tasks: z.array(z.string()).min(1).describe("Tasks to sequence (natural language descriptions)"),
      strategy: z.enum(["dependency", "locality", "risk-first"]).default("locality").describe("Sequencing strategy"),
    },
    async ({ tasks, strategy }) => {
      const ts = now();

      const classified = tasks.map((t) => ({
        task: t,
        cats: classify(t),
        dir: null as string | null,
      }));

      // For locality: infer directories from path-like tokens in task text
      if (strategy === "locality") {
        // Use git ls-files with a depth limit instead of find for performance
        const gitFiles = run("git ls-files 2>/dev/null | head -1000");
        const knownDirs = new Set<string>();
        for (const f of gitFiles.split("\n").filter(Boolean)) {
          const parts = f.split("/");
          if (parts.length >= 2) knownDirs.add(parts.slice(0, 2).join("/"));
          if (parts.length >= 1) knownDirs.add(parts[0]);
        }

        for (const item of classified) {
          const pathTokens = item.task.match(/[\w\-\/]+\.\w+|[\w\-]+\/[\w\-\/]*/g) || [];
          for (const token of pathTokens) {
            const dir = token.split("/").slice(0, 2).join("/");
            // Validate: must be a known git directory and safe path
            if (isSafePath(dir) && knownDirs.has(dir)) {
              item.dir = dir;
              break;
            }
          }
          if (!item.dir) {
            item.dir = CAT_DIR_MAP[item.cats[0]] ?? "src/";
          }
        }
      }

      let ordered: typeof classified;
      let reasoning: string[] = [];

      if (strategy === "dependency") {
        ordered = [...classified].sort((a, b) => {
          const aIndices = a.cats.map((c) => DEP_ORDER.indexOf(c)).filter((i) => i >= 0);
          const bIndices = b.cats.map((c) => DEP_ORDER.indexOf(c)).filter((i) => i >= 0);
          const aIdx = aIndices.length > 0 ? Math.min(...aIndices) : DEP_ORDER.length;
          const bIdx = bIndices.length > 0 ? Math.min(...bIndices) : DEP_ORDER.length;
          return aIdx - bIdx;
        });
        reasoning = ordered.map(
          (item, i) => `${i + 1}. **[${item.cats.join(",")}]** — ${DEP_ORDER.indexOf(item.cats[0]) <= 1 ? "foundational change, must come early" : "depends on earlier layers"}`
        );
      } else if (strategy === "risk-first") {
        ordered = [...classified].sort((a, b) => riskScore(b.cats) - riskScore(a.cats));
        reasoning = ordered.map(
          (item, i) => `${i + 1}. **[${item.cats.join(",")}]** risk=${riskScore(item.cats)} — ${riskScore(item.cats) >= 7 ? "high-risk, do while context is fresh" : "lower risk, safe to do later"}`
        );
      } else {
        ordered = [...classified].sort((a, b) => (a.dir ?? "").localeCompare(b.dir ?? ""));
        reasoning = ordered.map(
          (item, i) => `${i + 1}. dir=\`${item.dir}\` **[${item.cats.join(",")}]** — grouped by proximity`
        );
      }

      // Estimate context switches
      let switches = 0;
      for (let i = 1; i < ordered.length; i++) {
        const prevCats = new Set(ordered[i - 1].cats);
        const currCats = ordered[i].cats;
        const overlap = currCats.some((c) => prevCats.has(c));
        if (!overlap) switches++;
        if (strategy === "locality" && ordered[i].dir !== ordered[i - 1].dir) switches++;
      }

      // Parallelization warnings
      const warnings: string[] = [];
      const hasSchema = classified.some((t) => t.cats.includes("schema"));
      const hasTest = classified.some((t) => t.cats.includes("test"));
      const hasApi = classified.some((t) => t.cats.includes("api"));
      if (hasSchema && hasTest) warnings.push("⚠️ Schema changes and tests should NOT run in parallel — tests depend on schema state.");
      if (hasSchema && hasApi) warnings.push("⚠️ Schema migrations and API changes should be sequential — API may reference new columns/tables.");
      if (hasSchema) warnings.push("⚠️ Schema/migration tasks are non-parallelizable with anything that touches the DB.");

      // Circular dependency check
      const circularWarnings = detectCircularDeps(classified);
      warnings.push(...circularWarnings);

      const result = [
        `## Sequenced Tasks (strategy: ${strategy})`,
        `_Generated ${ts}_`,
        "",
        ...ordered.map((item, i) => `${i + 1}. ${item.task}`),
        "",
        "### Reasoning",
        ...reasoning,
        "",
        `**Estimated context switches:** ${switches}`,
        ...(warnings.length ? ["", "### Warnings", ...warnings] : []),
      ].join("\n");

      return { content: [{ type: "text" as const, text: result }] };
    }
  );
}
