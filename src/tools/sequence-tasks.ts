// CATEGORY 6: sequence_tasks — Sequencing
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { run } from "../lib/git.js";
import { now } from "../lib/state.js";
import { PROJECT_DIR } from "../lib/files.js";
import { existsSync } from "fs";
import { join } from "path";

type Cat = "schema" | "config" | "api" | "ui" | "test";

const CATEGORIES: Record<Cat, RegExp> = {
  schema: /\b(schema|migrat|database|db|table|column|index|alter|foreign.?key)\b/i,
  config: /\b(config|env|\.env|settings|secrets?|dotenv|yaml|toml)\b/i,
  api:    /\b(api|route|endpoint|controller|handler|middleware|graphql|rest|rpc)\b/i,
  ui:     /\b(ui|component|page|view|layout|template|css|style|frontend|react|vue|svelte)\b/i,
  test:   /\b(test|spec|e2e|cypress|playwright|jest|vitest|assert|fixture)\b/i,
};

const CAT_DIR_MAP: Record<string, string> = {
  schema: "db/", config: "config/", api: "api/", ui: "src/", test: "test/",
};

const DEP_ORDER: Cat[] = ["config", "schema", "api", "ui", "test"];

function classify(task: string): Cat[] {
  const cats = (Object.entries(CATEGORIES) as [Cat, RegExp][])
    .filter(([, re]) => re.test(task))
    .map(([k]) => k);
  return cats.length > 0 ? cats : ["ui"];
}

function riskScore(cats: Cat[]): number {
  let s = 0;
  if (cats.includes("schema")) s += 10;
  if (cats.includes("config")) s += 7;
  if (cats.includes("api")) s += 4;
  if (cats.includes("ui")) s += 2;
  if (cats.includes("test")) s += 1;
  return s;
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

      // For locality: infer directories
      if (strategy === "locality") {
        for (const item of classified) {
          const pathTokens = item.task.match(/[\w\-\/]+\.\w+|[\w\-]+\/[\w\-\/]*/g) || [];
          for (const token of pathTokens) {
            const dir = token.split("/").slice(0, 2).join("/");
            if (existsSync(join(PROJECT_DIR, dir))) {
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
          const aIdx = Math.min(...a.cats.map((c) => DEP_ORDER.indexOf(c)).filter((i) => i >= 0), 99);
          const bIdx = Math.min(...b.cats.map((c) => DEP_ORDER.indexOf(c)).filter((i) => i >= 0), 99);
          return aIdx - bIdx;
        });
        reasoning = ordered.map(
          (item, i) => `#${i + 1}: [${item.cats.join(",")}] — ${DEP_ORDER.indexOf(item.cats[0]) <= 1 ? "foundational change, must come early" : "depends on earlier layers"}`
        );
      } else if (strategy === "risk-first") {
        ordered = [...classified].sort((a, b) => riskScore(b.cats) - riskScore(a.cats));
        reasoning = ordered.map(
          (item, i) => `#${i + 1}: [${item.cats.join(",")}] risk=${riskScore(item.cats)} — ${riskScore(item.cats) >= 7 ? "high-risk, do while context is fresh" : "lower risk, safe to do later"}`
        );
      } else {
        ordered = [...classified].sort((a, b) => (a.dir ?? "").localeCompare(b.dir ?? ""));
        reasoning = ordered.map(
          (item, i) => `#${i + 1}: dir=${item.dir} [${item.cats.join(",")}] — grouped by proximity`
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

      const result = [
        `## Sequenced Tasks (strategy: ${strategy})`,
        `_Generated ${ts}_\n`,
        ...ordered.map((item, i) => `${i + 1}. ${item.task}`),
        `\n### Reasoning`,
        ...reasoning,
        `\n**Estimated context switches:** ${switches}`,
        ...(warnings.length ? [`\n### Parallelization Warnings`, ...warnings] : []),
      ].join("\n");

      return { content: [{ type: "text" as const, text: result }] };
    }
  );
}
