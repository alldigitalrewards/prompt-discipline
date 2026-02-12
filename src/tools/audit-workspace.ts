import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { run } from "../lib/git.js";
import { readIfExists, findWorkspaceDocs } from "../lib/files.js";

export function registerAuditWorkspace(server: McpServer): void {
  server.tool(
    "audit_workspace",
    `Audit workspace documentation freshness vs actual project state. Compares .claude/ workspace docs against recent git commits to find stale or missing documentation. Call after completing a batch of work or at session end.`,
    {},
    async () => {
      const docs = findWorkspaceDocs();
      const recentFiles = run("git diff --name-only HEAD~10 2>/dev/null || echo ''").split("\n").filter(Boolean);
      const sections: string[] = [];

      const docStatus: { name: string; ageHours: number; stale: boolean; size: number }[] = [];
      const currentTime = Date.now();
      for (const [name, info] of Object.entries(docs)) {
        const ageHours = Math.round((currentTime - info.mtime.getTime()) / 3600000);
        const stale = ageHours > 4;
        docStatus.push({ name, ageHours, stale, size: info.size });
      }

      sections.push(`## Workspace Doc Freshness\n| Doc | Age | Status |\n|-----|-----|--------|\n${docStatus.map(d =>
        `| .claude/${d.name} | ${d.ageHours}h | ${d.stale ? "🔴 STALE" : "🟢 Fresh"} |`
      ).join("\n")}`);

      const workAreas = new Set<string>();
      for (const f of recentFiles) {
        if (f.startsWith("tests/")) workAreas.add("tests");
        if (f.startsWith("app/w/") && f.includes("admin")) workAreas.add("admin");
        if (f.startsWith("app/w/") && f.includes("manager")) workAreas.add("manager");
        if (f.startsWith("app/w/") && f.includes("participant")) workAreas.add("participant");
        if (f.startsWith("app/api/")) workAreas.add("api");
        if (f.includes("prisma")) workAreas.add("schema");
      }

      const docNames = Object.keys(docs).join(" ").toLowerCase();
      const undocumented = [...workAreas].filter(area => !docNames.includes(area));

      if (undocumented.length > 0) {
        sections.push(`## Undocumented Work Areas\nRecent commits touched these areas but no workspace docs cover them:\n${undocumented.map(a => `- ❌ **${a}** — no .claude/ doc found`).join("\n")}`);
      }

      const gapTracker = readIfExists(".claude/playwright-test-suite/GAP-TRACKER.md", 100);
      if (gapTracker) {
        const testFilesCount = parseInt(run("find tests -name '*.spec.ts' 2>/dev/null | wc -l").trim()) || 0;
        sections.push(`## Gap Tracker Check\nTest files on disk: ${testFilesCount}\nGap tracker last updated: ${docStatus.find(d => d.name.includes("GAP"))?.ageHours || "?"}h ago`);
      }

      const staleCount = docStatus.filter(d => d.stale).length;
      sections.push(`## Recommendation\n${staleCount > 0
        ? `⚠️ ${staleCount} docs are stale. Update them to reflect current state before ending this session.`
        : "✅ Workspace docs are fresh."
      }${undocumented.length > 0
        ? `\n⚠️ ${undocumented.length} work areas have no docs. Consider creating workspace docs for: ${undocumented.join(", ")}`
        : ""
      }`);

      return { content: [{ type: "text" as const, text: sections.join("\n\n") }] };
    }
  );
}
