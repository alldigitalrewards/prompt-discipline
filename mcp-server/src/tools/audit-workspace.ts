import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { run } from "../lib/git.js";
import { readIfExists, findWorkspaceDocs } from "../lib/files.js";

/** Extract top-level work areas from file paths generically */
function detectWorkAreas(files: string[]): Set<string> {
  const areas = new Set<string>();
  for (const f of files) {
    if (!f || f.startsWith(".")) continue;

    // Use first 1-2 path segments as the area
    const parts = f.split("/");
    if (parts.length >= 2) {
      // For test-like directories, just use "tests"
      if (/^(tests?|__tests__|spec)$/i.test(parts[0])) {
        areas.add("tests");
      } else if (parts.length >= 3) {
        // e.g. app/api/foo → "app/api", src/components/Bar → "src/components"
        areas.add(`${parts[0]}/${parts[1]}`);
      } else {
        areas.add(parts[0]);
      }
    } else {
      // Root-level files: group by extension category
      if (/\.(json|ya?ml|toml|lock)$/.test(f)) areas.add("config");
      else areas.add("root");
    }
  }
  return areas;
}

export function registerAuditWorkspace(server: McpServer): void {
  server.tool(
    "audit_workspace",
    `Audit workspace documentation freshness vs actual project state. Compares .claude/ workspace docs against recent git commits to find stale or missing documentation. Call after completing a batch of work or at session end.`,
    {},
    async () => {
      const docs = findWorkspaceDocs();
      const recentFiles = run("git diff --name-only HEAD~10 2>/dev/null || echo ''").split("\n").filter(Boolean);
      const sections: string[] = [];

      // Doc freshness
      const docStatus: { name: string; ageHours: number; stale: boolean; size: number }[] = [];
      const currentTime = Date.now();
      for (const [name, info] of Object.entries(docs)) {
        const ageHours = Math.round((currentTime - info.mtime.getTime()) / 3600000);
        const stale = ageHours > 4;
        docStatus.push({ name, ageHours, stale, size: info.size });
      }

      // Use bullet list format (renders everywhere)
      sections.push(`## Workspace Doc Freshness\n${docStatus.length > 0
        ? docStatus.map(d =>
          `- .claude/${d.name} — ${d.ageHours}h old ${d.stale ? "🔴 STALE" : "🟢 Fresh"}`
        ).join("\n")
        : "No workspace docs found."
      }`);

      // Detect work areas generically from git diffs
      const workAreas = detectWorkAreas(recentFiles);

      // Check which areas lack docs
      const docNames = Object.keys(docs).join(" ").toLowerCase();
      const undocumented = [...workAreas].filter(area => {
        const areaLower = area.toLowerCase();
        // Check if any doc name contains the area name (or key parts)
        const keywords = areaLower.split("/").filter(Boolean);
        return !keywords.some(kw => docNames.includes(kw));
      });

      if (undocumented.length > 0) {
        sections.push(`## Undocumented Work Areas\nRecent commits touched these areas but no workspace docs cover them:\n${undocumented.map(a => `- ❌ **${a}**`).join("\n")}`);
      }

      // Check for gap trackers or similar tracking docs
      const trackingDocs = Object.entries(docs).filter(([n]) => /gap|track|progress/i.test(n));
      if (trackingDocs.length > 0) {
        const testFilesCount = parseInt(run("find tests -name '*.spec.ts' -o -name '*.test.ts' 2>/dev/null | wc -l").trim()) || 0;
        sections.push(`## Tracking Docs\n${trackingDocs.map(([n]) => {
          const age = docStatus.find(d => d.name === n)?.ageHours ?? "?";
          return `- .claude/${n} — last updated ${age}h ago`;
        }).join("\n")}\nTest files on disk: ${testFilesCount}`);
      }

      // Summary
      const staleCount = docStatus.filter(d => d.stale).length;
      const recs: string[] = [];
      if (staleCount > 0) recs.push(`⚠️ ${staleCount} docs are stale. Update them before ending this session.`);
      else recs.push("✅ Workspace docs are fresh.");
      if (undocumented.length > 0) recs.push(`⚠️ ${undocumented.length} work areas have no docs. Consider creating docs for: ${undocumented.join(", ")}`);

      sections.push(`## Recommendation\n${recs.join("\n")}`);

      return { content: [{ type: "text" as const, text: sections.join("\n\n") }] };
    }
  );
}
