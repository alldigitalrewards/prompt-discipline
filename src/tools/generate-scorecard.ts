// =============================================================================
// generate_scorecard — 12-category prompt discipline report cards (PDF/Markdown)
// With trend reports, comparative reports, and historical baselines
// =============================================================================

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  findSessionDirs,
  findSessionFiles,
  parseSession,
  type TimelineEvent,
} from "../lib/session-parser.js";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { createHash } from "crypto";

// ── Types ──────────────────────────────────────────────────────────────────

interface CategoryScore {
  name: string;
  score: number;
  grade: string;
  evidence: string;
  examples?: { good?: string[]; bad?: string[] };
}

interface Scorecard {
  project: string;
  period: string;
  date: string;
  overall: number;
  overallGrade: string;
  categories: CategoryScore[];
  highlights: { best: CategoryScore; worst: CategoryScore };
}

// ── Grading ────────────────────────────────────────────────────────────────

function letterGrade(score: number): string {
  if (score >= 95) return "A+";
  if (score >= 90) return "A";
  if (score >= 85) return "A-";
  if (score >= 80) return "B+";
  if (score >= 75) return "B";
  if (score >= 70) return "B-";
  if (score >= 65) return "C+";
  if (score >= 60) return "C";
  if (score >= 55) return "C-";
  if (score >= 50) return "D";
  return "F";
}

function clamp(v: number): number {
  return Math.max(0, Math.min(100, Math.round(v)));
}

// ── Helpers ────────────────────────────────────────────────────────────────

const PATH_RE = /(?:\/[\w./-]+\.\w{1,6}|\b\w+\.\w{2,6}\b)/;
const FILE_EXT_RE = /\.\b(?:ts|tsx|js|jsx|py|rs|go|rb|java|c|cpp|h|css|scss|html|json|yaml|yml|toml|md|sql|sh)\b/;
const CORRECTION_PATTERNS = [/\bno\b/i, /\bwrong\b/i, /\bnot that\b/i, /\bi meant\b/i, /\bactually\b/i, /\binstead\b/i, /\bundo\b/i, /\brevert\b/i];

interface ParsedSession {
  id: string;
  events: TimelineEvent[];
  userMessages: TimelineEvent[];
  assistantMessages: TimelineEvent[];
  toolCalls: TimelineEvent[];
  corrections: TimelineEvent[];
  compactions: TimelineEvent[];
  commits: TimelineEvent[];
  subAgentSpawns: TimelineEvent[];
  durationMinutes: number;
}

function classifyEvents(events: TimelineEvent[]): ParsedSession {
  const userMessages = events.filter((e) => e.type === "user_prompt");
  const assistantMessages = events.filter((e) => e.type === "assistant_response");
  const toolCalls = events.filter((e) => e.type === "tool_call");
  const corrections = events.filter((e) => e.type === "correction");
  const compactions = events.filter((e) => e.type === "compaction");
  const commits = events.filter((e) => e.type === "git_commit");
  const subAgentSpawns = events.filter((e) => e.type === "sub_agent_spawn");

  let durationMinutes = 0;
  if (events.length >= 2) {
    const first = new Date(events[0].timestamp).getTime();
    const last = new Date(events[events.length - 1].timestamp).getTime();
    if (!isNaN(first) && !isNaN(last)) {
      durationMinutes = (last - first) / 60000;
    }
  }

  return {
    id: events[0]?.session_id ?? "unknown",
    events,
    userMessages,
    assistantMessages,
    toolCalls,
    corrections,
    compactions,
    commits,
    subAgentSpawns,
    durationMinutes,
  };
}

function hasFileRef(text: string): boolean {
  return PATH_RE.test(text) || FILE_EXT_RE.test(text);
}

function pct(num: number, den: number): number {
  return den === 0 ? 100 : Math.round((num / den) * 100);
}

// ── Scoring Functions ──────────────────────────────────────────────────────

function scorePlans(sessions: ParsedSession[]): CategoryScore {
  if (sessions.length === 0) return { name: "Plans", score: 75, grade: "B", evidence: "No sessions to analyze" };

  let planned = 0;
  for (const s of sessions) {
    const first3 = s.userMessages.slice(0, 3);
    const hasPlanning = first3.some((m) => m.content.length > 100 && hasFileRef(m.content));
    if (hasPlanning) planned++;
  }
  const score = clamp(pct(planned, sessions.length));
  return {
    name: "Plans",
    score,
    grade: letterGrade(score),
    evidence: `${planned}/${sessions.length} sessions began with file-specific planning prompts (>100 chars with file references).`,
  };
}

function scoreClarification(sessions: ParsedSession[]): CategoryScore {
  let specific = 0, total = 0;
  for (const s of sessions) {
    for (const m of s.userMessages) {
      total++;
      if (hasFileRef(m.content)) specific++;
    }
  }
  const score = clamp(pct(specific, total));
  return {
    name: "Clarification",
    score,
    grade: letterGrade(score),
    evidence: `${specific}/${total} user prompts contained file paths or specific identifiers.`,
  };
}

function scoreDelegation(sessions: ParsedSession[]): CategoryScore {
  let total = 0, quality = 0;
  for (const s of sessions) {
    for (const e of s.subAgentSpawns) {
      total++;
      if (e.content.length > 200) quality++;
    }
  }
  if (total === 0) return { name: "Delegation", score: 75, grade: "B", evidence: "No sub-agent spawns detected. Default score." };
  const score = clamp(pct(quality, total));
  return {
    name: "Delegation",
    score,
    grade: letterGrade(score),
    evidence: `${quality}/${total} sub-agent tasks had detailed descriptions (>200 chars).`,
  };
}

function scoreFollowUpSpecificity(sessions: ParsedSession[]): CategoryScore {
  let followUps = 0, specific = 0;
  const badExamples: string[] = [];
  const goodExamples: string[] = [];

  for (const s of sessions) {
    for (let i = 0; i < s.events.length; i++) {
      const ev = s.events[i];
      if (ev.type !== "user_prompt") continue;
      // Check if preceded by assistant
      const prev = s.events.slice(0, i).reverse().find((e) => e.type === "assistant_response" || e.type === "user_prompt");
      if (prev?.type !== "assistant_response") continue;

      followUps++;
      if (hasFileRef(ev.content) || ev.content.length >= 50) {
        specific++;
        if (goodExamples.length < 3 && hasFileRef(ev.content)) goodExamples.push(ev.content.slice(0, 120));
      } else {
        if (badExamples.length < 3) badExamples.push(ev.content.slice(0, 80));
      }
    }
  }
  const score = clamp(pct(specific, followUps));
  return {
    name: "Follow-up Specificity",
    score,
    grade: letterGrade(score),
    evidence: `${specific}/${followUps} follow-up prompts had specific file references or sufficient detail.`,
    examples: { good: goodExamples.length ? goodExamples : undefined, bad: badExamples.length ? badExamples : undefined },
  };
}

function scoreTokenEfficiency(sessions: ParsedSession[]): CategoryScore {
  let totalCalls = 0, totalFiles = 0;
  for (const s of sessions) {
    totalCalls += s.toolCalls.length;
    const files = new Set<string>();
    for (const tc of s.toolCalls) {
      const match = tc.content.match(/(?:file_path|path)["']?\s*[:=]\s*["']([^"']+)/);
      if (match) files.add(match[1]);
    }
    totalFiles += files.size || 1;
  }
  // Ratio: lower tool_calls per file = better. Ideal ~5-10 calls per file.
  const ratio = totalCalls / totalFiles;
  let score: number;
  if (ratio <= 5) score = 100;
  else if (ratio <= 10) score = 90;
  else if (ratio <= 20) score = 75;
  else if (ratio <= 40) score = 60;
  else score = 40;

  // Deduct for sessions with >200 tool calls
  const bloated = sessions.filter((s) => s.toolCalls.length > 200).length;
  if (bloated > 0) score = clamp(score - bloated * 10);

  return {
    name: "Token Efficiency",
    score: clamp(score),
    grade: letterGrade(clamp(score)),
    evidence: `${totalCalls} tool calls across ${totalFiles} unique files (ratio: ${ratio.toFixed(1)}). ${bloated} session(s) exceeded 200 tool calls.`,
  };
}

function scoreSequencing(sessions: ParsedSession[]): CategoryScore {
  let totalSwitches = 0, totalPrompts = 0;
  for (const s of sessions) {
    let lastArea = "";
    for (const m of s.userMessages) {
      totalPrompts++;
      const pathMatch = m.content.match(/(?:\/[\w./-]+)/);
      const area = pathMatch ? pathMatch[0].split("/").slice(0, -1).join("/") : "";
      if (area && lastArea && area !== lastArea) totalSwitches++;
      if (area) lastArea = area;
    }
  }
  // Fewer switches = better. Target: <10% switch rate
  const switchRate = totalPrompts > 0 ? totalSwitches / totalPrompts : 0;
  let score: number;
  if (switchRate <= 0.05) score = 100;
  else if (switchRate <= 0.1) score = 90;
  else if (switchRate <= 0.2) score = 75;
  else if (switchRate <= 0.35) score = 60;
  else score = 45;

  return {
    name: "Sequencing",
    score: clamp(score),
    grade: letterGrade(clamp(score)),
    evidence: `${totalSwitches} topic switches across ${totalPrompts} prompts (${(switchRate * 100).toFixed(0)}% switch rate).`,
  };
}

function scoreCompactionManagement(sessions: ParsedSession[]): CategoryScore {
  let totalCompactions = 0, covered = 0;
  for (const s of sessions) {
    if (s.compactions.length === 0) continue;
    for (const c of s.compactions) {
      totalCompactions++;
      const cIdx = s.events.indexOf(c);
      const nearby = s.events.slice(Math.max(0, cIdx - 10), cIdx);
      if (nearby.some((e) => e.type === "git_commit")) covered++;
    }
  }
  if (totalCompactions === 0) return { name: "Compaction Management", score: 100, grade: "A+", evidence: "No compactions needed — sessions stayed manageable." };
  const score = clamp(pct(covered, totalCompactions));
  return {
    name: "Compaction Management",
    score,
    grade: letterGrade(score),
    evidence: `${covered}/${totalCompactions} compactions were preceded by a commit within 10 messages.`,
  };
}

function scoreSessionLifecycle(sessions: ParsedSession[]): CategoryScore {
  if (sessions.length === 0) return { name: "Session Lifecycle", score: 75, grade: "B", evidence: "No sessions." };
  let good = 0;
  for (const s of sessions) {
    if (s.durationMinutes <= 0) { good++; continue; }
    if (s.durationMinutes > 180 && s.commits.length === 0) continue; // bad
    const commitInterval = s.commits.length > 0 ? s.durationMinutes / s.commits.length : s.durationMinutes;
    if (commitInterval <= 30) good++;
    else if (commitInterval <= 60) good += 0.5;
  }
  const score = clamp(pct(Math.round(good), sessions.length));
  return {
    name: "Session Lifecycle",
    score,
    grade: letterGrade(score),
    evidence: `${Math.round(good)}/${sessions.length} sessions had healthy commit frequency (every 15-30 min).`,
  };
}

function scoreErrorRecovery(sessions: ParsedSession[]): CategoryScore {
  let totalCorrections = 0, fastRecoveries = 0, totalMessages = 0;
  for (const s of sessions) {
    totalMessages += s.events.length;
    for (const c of s.corrections) {
      totalCorrections++;
      const cIdx = s.events.indexOf(c);
      const after = s.events.slice(cIdx + 1, cIdx + 3);
      if (after.some((e) => e.type === "tool_call" || e.type === "assistant_response")) fastRecoveries++;
    }
  }
  if (totalCorrections === 0) return { name: "Error Recovery", score: 95, grade: "A", evidence: "No corrections needed." };
  const correctionRate = totalMessages > 0 ? totalCorrections / totalMessages : 0;
  let score = clamp(100 - correctionRate * 500);
  if (totalCorrections > 0) {
    const recoveryBonus = pct(fastRecoveries, totalCorrections) * 0.2;
    score = clamp(score + recoveryBonus);
  }
  return {
    name: "Error Recovery",
    score,
    grade: letterGrade(score),
    evidence: `${totalCorrections} corrections (${(correctionRate * 100).toFixed(1)}% of messages). ${fastRecoveries} recovered within 2 messages.`,
  };
}

function scoreWorkspaceHygiene(sessions: ParsedSession[]): CategoryScore {
  let bonus = 0;
  for (const s of sessions) {
    const allContent = s.events.map((e) => e.content).join(" ");
    if (/\.claude\//.test(allContent) || /CLAUDE\.md/.test(allContent)) bonus++;
  }
  const score = clamp(75 + (bonus > 0 ? Math.min(bonus * 5, 20) : 0));
  return {
    name: "Workspace Hygiene",
    score,
    grade: letterGrade(score),
    evidence: `Default baseline 75. ${bonus} session(s) referenced .claude/ workspace docs (+bonus).`,
  };
}

function scoreCrossSessionContinuity(sessions: ParsedSession[]): CategoryScore {
  if (sessions.length === 0) return { name: "Cross-Session Continuity", score: 75, grade: "B", evidence: "No sessions." };
  let good = 0;
  for (const s of sessions) {
    const first3Tools = s.toolCalls.slice(0, 3);
    const readsContext = first3Tools.some((tc) =>
      /CLAUDE\.md|\.claude\/|checkpoint|context|README/i.test(tc.content)
    );
    if (readsContext) good++;
  }
  const score = clamp(pct(good, sessions.length));
  return {
    name: "Cross-Session Continuity",
    score,
    grade: letterGrade(score),
    evidence: `${good}/${sessions.length} sessions started by reading project context docs.`,
  };
}

function scoreVerification(sessions: ParsedSession[]): CategoryScore {
  if (sessions.length === 0) return { name: "Verification", score: 75, grade: "B", evidence: "No sessions." };
  let verified = 0;
  for (const s of sessions) {
    const totalEvents = s.events.length;
    const tail = s.events.slice(Math.max(0, Math.floor(totalEvents * 0.9)));
    const hasVerification = tail.some((e) =>
      e.type === "tool_call" && /test|build|lint|check|verify|jest|vitest|pytest|cargo.test/i.test(e.content)
    );
    if (hasVerification) verified++;
  }
  const score = clamp(pct(verified, sessions.length));
  return {
    name: "Verification",
    score,
    grade: letterGrade(score),
    evidence: `${verified}/${sessions.length} sessions ran tests/builds in the final 10% of events.`,
  };
}

// ── Main Scoring ───────────────────────────────────────────────────────────

function computeScorecard(
  sessions: ParsedSession[],
  project: string,
  period: string,
): Scorecard {
  const categories: CategoryScore[] = [
    scorePlans(sessions),
    scoreClarification(sessions),
    scoreDelegation(sessions),
    scoreFollowUpSpecificity(sessions),
    scoreTokenEfficiency(sessions),
    scoreSequencing(sessions),
    scoreCompactionManagement(sessions),
    scoreSessionLifecycle(sessions),
    scoreErrorRecovery(sessions),
    scoreWorkspaceHygiene(sessions),
    scoreCrossSessionContinuity(sessions),
    scoreVerification(sessions),
  ];

  const overall = clamp(Math.round(categories.reduce((s, c) => s + c.score, 0) / categories.length));
  const sorted = [...categories].sort((a, b) => b.score - a.score);

  return {
    project,
    period,
    date: new Date().toISOString().slice(0, 10),
    overall,
    overallGrade: letterGrade(overall),
    categories,
    highlights: { best: sorted[0], worst: sorted[sorted.length - 1] },
  };
}

// ── Markdown Output ────────────────────────────────────────────────────────

function toMarkdown(sc: Scorecard): string {
  const lines: string[] = [];
  lines.push(`# 📊 Prompt Discipline Scorecard`);
  lines.push(`**Project:** ${sc.project} | **Period:** ${sc.period} (${sc.date}) | **Overall: ${sc.overallGrade} (${sc.overall}/100)**\n`);

  lines.push(`## Category Scores`);
  lines.push(`| # | Category | Score | Grade |`);
  lines.push(`|---|----------|-------|-------|`);
  sc.categories.forEach((c, i) => {
    lines.push(`| ${i + 1} | ${c.name} | ${c.score} | ${c.grade} |`);
  });

  lines.push(`\n## Highlights`);
  lines.push(`- 🏆 **Best:** ${sc.highlights.best.name} (${sc.highlights.best.grade}) — ${sc.highlights.best.evidence}`);
  lines.push(`- ⚠️ **Worst:** ${sc.highlights.worst.name} (${sc.highlights.worst.grade}) — ${sc.highlights.worst.evidence}`);

  lines.push(`\n## Detailed Breakdown`);
  sc.categories.forEach((c, i) => {
    lines.push(`\n### ${i + 1}. ${c.name} — ${c.grade} (${c.score}/100)`);
    lines.push(`Evidence: ${c.evidence}`);
    if (c.examples?.bad?.length) {
      lines.push(`\nExamples of vague follow-ups:`);
      c.examples.bad.forEach((e) => lines.push(`- ❌ "${e}"`));
    }
    if (c.examples?.good?.length) {
      lines.push(`\nExamples of specific follow-ups:`);
      c.examples.good.forEach((e) => lines.push(`- ✅ "${e}"`));
    }
  });

  return lines.join("\n");
}

// ── HTML / PDF Output ──────────────────────────────────────────────────────

function gradeColor(grade: string): string {
  if (grade.startsWith("A")) return "#22c55e";
  if (grade.startsWith("B")) return "#eab308";
  if (grade.startsWith("C")) return "#f97316";
  return "#ef4444";
}

function generateRadarSVG(categories: CategoryScore[]): string {
  const cx = 200, cy = 200, r = 150;
  const n = categories.length;
  const points = categories.map((c, i) => {
    const angle = (Math.PI * 2 * i) / n - Math.PI / 2;
    const dist = (c.score / 100) * r;
    return { x: cx + dist * Math.cos(angle), y: cy + dist * Math.sin(angle) };
  });
  const gridLines = [0.25, 0.5, 0.75, 1].map((f) => {
    const gr = r * f;
    const pts = Array.from({ length: n }, (_, i) => {
      const angle = (Math.PI * 2 * i) / n - Math.PI / 2;
      return `${cx + gr * Math.cos(angle)},${cy + gr * Math.sin(angle)}`;
    }).join(" ");
    return `<polygon points="${pts}" fill="none" stroke="#e5e7eb" stroke-width="1"/>`;
  }).join("");

  const labels = categories.map((c, i) => {
    const angle = (Math.PI * 2 * i) / n - Math.PI / 2;
    const lx = cx + (r + 30) * Math.cos(angle);
    const ly = cy + (r + 30) * Math.sin(angle);
    const anchor = Math.abs(angle) < 0.1 || Math.abs(angle - Math.PI) < 0.1 ? "middle" : angle > -Math.PI / 2 && angle < Math.PI / 2 ? "start" : "end";
    return `<text x="${lx}" y="${ly}" text-anchor="${anchor}" font-size="10" fill="#6b7280">${c.name.slice(0, 12)}</text>`;
  }).join("");

  const polygon = points.map((p) => `${p.x},${p.y}`).join(" ");

  return `<svg viewBox="0 0 400 400" width="400" height="400" xmlns="http://www.w3.org/2000/svg">
    ${gridLines}
    <polygon points="${polygon}" fill="rgba(59,130,246,0.2)" stroke="#3b82f6" stroke-width="2"/>
    ${points.map((p) => `<circle cx="${p.x}" cy="${p.y}" r="4" fill="#3b82f6"/>`).join("")}
    ${labels}
  </svg>`;
}

function toHTML(sc: Scorecard): string {
  const radar = generateRadarSVG(sc.categories);
  const rows = sc.categories.map((c, i) => `
    <tr>
      <td style="padding:8px;border-bottom:1px solid #e5e7eb">${i + 1}</td>
      <td style="padding:8px;border-bottom:1px solid #e5e7eb;font-weight:600">${c.name}</td>
      <td style="padding:8px;border-bottom:1px solid #e5e7eb;text-align:center">${c.score}</td>
      <td style="padding:8px;border-bottom:1px solid #e5e7eb;text-align:center">
        <span style="background:${gradeColor(c.grade)};color:white;padding:2px 8px;border-radius:4px;font-weight:700">${c.grade}</span>
      </td>
    </tr>`).join("");

  const details = sc.categories.map((c, i) => {
    let html = `<div style="margin-bottom:16px"><h3 style="margin:0 0 4px">${i + 1}. ${c.name} — <span style="color:${gradeColor(c.grade)}">${c.grade}</span> (${c.score}/100)</h3><p style="color:#6b7280;margin:0">${c.evidence}</p>`;
    if (c.examples?.bad?.length) {
      html += `<div style="margin-top:6px">${c.examples.bad.map((e) => `<div style="color:#ef4444;font-size:13px">❌ "${e}"</div>`).join("")}</div>`;
    }
    if (c.examples?.good?.length) {
      html += `<div style="margin-top:4px">${c.examples.good.map((e) => `<div style="color:#22c55e;font-size:13px">✅ "${e}"</div>`).join("")}</div>`;
    }
    return html + `</div>`;
  }).join("");

  return `<!DOCTYPE html><html><head><meta charset="utf-8"/></head><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;margin:0;color:#1f2937">
  <div style="background:linear-gradient(135deg,#1e293b,#0f172a);color:white;padding:32px 40px;display:flex;align-items:center;justify-content:space-between">
    <div>
      <h1 style="margin:0;font-size:28px">📊 Prompt Discipline Scorecard</h1>
      <p style="margin:8px 0 0;opacity:0.8">Project: <strong>${sc.project}</strong> | Period: ${sc.period} | ${sc.date}</p>
    </div>
    <div style="width:100px;height:100px;border-radius:50%;background:${gradeColor(sc.overallGrade)};display:flex;align-items:center;justify-content:center;flex-direction:column">
      <div style="font-size:28px;font-weight:800;line-height:1">${sc.overallGrade}</div>
      <div style="font-size:14px;opacity:0.9">${sc.overall}/100</div>
    </div>
  </div>
  <div style="padding:32px 40px;display:flex;gap:40px;flex-wrap:wrap">
    <div style="flex:1;min-width:300px">
      <h2 style="margin:0 0 12px">Category Scores</h2>
      <table style="width:100%;border-collapse:collapse;font-size:14px">
        <thead><tr style="background:#f9fafb"><th style="padding:8px;text-align:left">#</th><th style="padding:8px;text-align:left">Category</th><th style="padding:8px;text-align:center">Score</th><th style="padding:8px;text-align:center">Grade</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <div style="flex:0 0 auto">${radar}</div>
  </div>
  <div style="padding:0 40px 20px">
    <div style="background:#f0fdf4;border-left:4px solid #22c55e;padding:12px 16px;margin-bottom:8px;border-radius:4px">🏆 <strong>Best:</strong> ${sc.highlights.best.name} (${sc.highlights.best.grade}) — ${sc.highlights.best.evidence}</div>
    <div style="background:#fef2f2;border-left:4px solid #ef4444;padding:12px 16px;border-radius:4px">⚠️ <strong>Needs work:</strong> ${sc.highlights.worst.name} (${sc.highlights.worst.grade}) — ${sc.highlights.worst.evidence}</div>
  </div>
  <div style="padding:20px 40px 40px">
    <h2 style="margin:0 0 16px">Detailed Breakdown</h2>
    ${details}
  </div>
</body></html>`;
}

async function generatePDF(html: string, outputPath: string): Promise<void> {
  const { chromium } = await import("playwright" as string) as any;
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: "networkidle" });
  await page.pdf({
    path: outputPath,
    format: "A4",
    margin: { top: "1cm", bottom: "1cm", left: "1cm", right: "1cm" },
  });
  await browser.close();
}

// ── Session Loading ────────────────────────────────────────────────────────

function loadSessions(opts: {
  project?: string;
  sessionId?: string;
  since?: string;
  period: string;
}): ParsedSession[] {
  const dirs = findSessionDirs();
  let targetDirs = dirs;

  if (opts.project) {
    targetDirs = dirs.filter((d) =>
      d.projectName.toLowerCase().includes(opts.project!.toLowerCase()) ||
      d.project.toLowerCase().includes(opts.project!.toLowerCase())
    );
  }

  // Determine time filter
  let sinceDate: Date | null = null;
  if (opts.since) {
    const relMatch = opts.since.match(/^(\d+)\s*days?$/i);
    if (relMatch) {
      sinceDate = new Date(Date.now() - parseInt(relMatch[1]) * 86400000);
    } else {
      sinceDate = new Date(opts.since);
    }
  } else {
    const now = new Date();
    switch (opts.period) {
      case "day": sinceDate = new Date(now.getTime() - 86400000); break;
      case "week": sinceDate = new Date(now.getTime() - 7 * 86400000); break;
      case "month": sinceDate = new Date(now.getTime() - 30 * 86400000); break;
    }
  }

  const sessions: ParsedSession[] = [];

  for (const dir of targetDirs) {
    const files = findSessionFiles(dir.sessionDir);
    for (const f of files) {
      if (opts.sessionId && f.sessionId !== opts.sessionId) continue;
      if (sinceDate && f.mtime < sinceDate) continue;

      try {
        const events = parseSession(f.path, dir.project, dir.projectName);
        if (events.length > 0) {
          sessions.push(classifyEvents(events));
        }
      } catch {
        // Skip unparseable files
      }
    }
  }

  return sessions;
}

// ── Historical Baseline ────────────────────────────────────────────────────

const PREFLIGHT_DIR = join(homedir(), ".preflight", "projects");

function baselinePath(project: string): string {
  const hash = createHash("md5").update(project).digest("hex").slice(0, 12);
  return join(PREFLIGHT_DIR, hash, "baseline.json");
}

interface BaselineData {
  categoryAverages: Record<string, number>;
  overallAverage: number;
  sessionCount: number;
  lastUpdated: string;
}

function loadBaseline(project: string): BaselineData | null {
  const p = baselinePath(project);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as BaselineData;
  } catch {
    return null;
  }
}

function saveBaseline(project: string, data: BaselineData): void {
  const p = baselinePath(project);
  const dir = p.replace(/\/[^/]+$/, "");
  mkdirSync(dir, { recursive: true });
  writeFileSync(p, JSON.stringify(data, null, 2));
}

function updateBaseline(project: string, scorecard: Scorecard): void {
  const existing = loadBaseline(project);
  if (!existing) {
    const categoryAverages: Record<string, number> = {};
    for (const c of scorecard.categories) categoryAverages[c.name] = c.score;
    saveBaseline(project, {
      categoryAverages,
      overallAverage: scorecard.overall,
      sessionCount: 1,
      lastUpdated: new Date().toISOString(),
    });
    return;
  }
  const n = existing.sessionCount;
  const newN = n + 1;
  existing.overallAverage = Math.round((existing.overallAverage * n + scorecard.overall) / newN);
  for (const c of scorecard.categories) {
    const prev = existing.categoryAverages[c.name] ?? c.score;
    existing.categoryAverages[c.name] = Math.round((prev * n + c.score) / newN);
  }
  existing.sessionCount = newN;
  existing.lastUpdated = new Date().toISOString();
  saveBaseline(project, existing);
}

function trendArrow(current: number, previous: number): string {
  const diff = current - previous;
  if (diff > 5) return "↑";
  if (diff < -5) return "↓";
  return "→";
}

// ── Trend Report ───────────────────────────────────────────────────────────

interface DailyScore {
  date: string;
  score: number;
  categories: CategoryScore[];
  sessionCount: number;
  promptCount: number;
  toolCallCount: number;
  correctionCount: number;
  compactionCount: number;
}

function generateTrendSVG(dailyScores: { date: string; score: number }[]): string {
  const W = 400, H = 200, pad = 40;
  const plotW = W - pad * 2, plotH = H - pad * 2;
  const n = dailyScores.length;
  if (n === 0) return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg"><text x="${W / 2}" y="${H / 2}" text-anchor="middle" fill="#6b7280">No data</text></svg>`;

  const points = dailyScores.map((d, i) => ({
    x: pad + (n === 1 ? plotW / 2 : (i / (n - 1)) * plotW),
    y: pad + plotH - (d.score / 100) * plotH,
  }));

  const gridLines = [0, 25, 50, 75, 100].map((v) => {
    const y = pad + plotH - (v / 100) * plotH;
    return `<line x1="${pad}" y1="${y}" x2="${W - pad}" y2="${y}" stroke="#e5e7eb" stroke-width="1"/><text x="${pad - 5}" y="${y + 4}" text-anchor="end" font-size="10" fill="#9ca3af">${v}</text>`;
  }).join("");

  const labels = dailyScores.map((d, i) => {
    const x = pad + (n === 1 ? plotW / 2 : (i / (n - 1)) * plotW);
    const label = d.date.slice(5); // MM-DD
    return `<text x="${x}" y="${H - 8}" text-anchor="middle" font-size="9" fill="#9ca3af">${label}</text>`;
  }).join("");

  const pathD = points.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x} ${p.y}`).join(" ");
  const dots = points.map((p) => `<circle cx="${p.x}" cy="${p.y}" r="3" fill="#3b82f6"/>`).join("");

  return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
  <rect width="${W}" height="${H}" fill="white" rx="4"/>
  ${gridLines}
  <path d="${pathD}" fill="none" stroke="#3b82f6" stroke-width="2"/>
  ${dots}
  ${labels}
</svg>`;
}

function groupSessionsByDay(sessions: ParsedSession[]): Map<string, ParsedSession[]> {
  const map = new Map<string, ParsedSession[]>();
  for (const s of sessions) {
    const ts = s.events[0]?.timestamp;
    if (!ts) continue;
    const day = new Date(ts).toISOString().slice(0, 10);
    if (!map.has(day)) map.set(day, []);
    map.get(day)!.push(s);
  }
  return map;
}

function scoreDailyData(sessions: ParsedSession[]): DailyScore[] {
  const byDay = groupSessionsByDay(sessions);
  const days = [...byDay.keys()].sort();
  return days.map((date) => {
    const daySessions = byDay.get(date)!;
    const sc = computeScorecard(daySessions, "", date);
    return {
      date,
      score: sc.overall,
      categories: sc.categories,
      sessionCount: daySessions.length,
      promptCount: daySessions.reduce((s, d) => s + d.userMessages.length, 0),
      toolCallCount: daySessions.reduce((s, d) => s + d.toolCalls.length, 0),
      correctionCount: daySessions.reduce((s, d) => s + d.corrections.length, 0),
      compactionCount: daySessions.reduce((s, d) => s + d.compactions.length, 0),
    };
  });
}

function findBestWorstPrompt(sessions: ParsedSession[]): { best: string; worst: string } {
  let best = "", worst = "";
  let bestScore = -1, worstScore = Infinity;

  for (const s of sessions) {
    for (const m of s.userMessages) {
      const text = m.content;
      if (text.length < 5) continue;
      // Score: length + file refs bonus
      const score = text.length + (hasFileRef(text) ? 200 : 0);
      if (score > bestScore) { bestScore = score; best = text; }
      if (score < worstScore) { worstScore = score; worst = text; }
    }
  }
  return {
    best: best.slice(0, 300),
    worst: worst.slice(0, 200),
  };
}

interface TrendReport {
  project: string;
  period: string;
  dailyScores: DailyScore[];
  categoryTrends: { name: string; current: number; previous: number; arrow: string }[];
  top3Improve: { category: string; score: number; recommendation: string }[];
  bestPrompt: string;
  worstPrompt: string;
  stats: { sessions: number; prompts: number; toolCalls: number; correctionRate: number; compactions: number };
  baseline: BaselineData | null;
  svg: string;
}

const IMPROVEMENT_TIPS: Record<string, string> = {
  "Plans": "Start sessions with a detailed plan: list files to touch, expected changes, and success criteria before coding.",
  "Clarification": "Always reference specific file paths and function names in your prompts instead of speaking abstractly.",
  "Delegation": "When spawning sub-agents, provide detailed context: file paths, expected output format, and constraints.",
  "Follow-up Specificity": "After receiving a response, reference specific lines/files rather than saying 'fix it' or 'try again'.",
  "Token Efficiency": "Batch related changes into single prompts. Avoid asking for one small change at a time.",
  "Sequencing": "Complete work in one area before moving to the next. Avoid jumping between unrelated files.",
  "Compaction Management": "Commit before context compaction hits. Keep sessions focused to avoid hitting limits.",
  "Session Lifecycle": "Commit every 15-30 minutes. Don't let sessions run 3+ hours without checkpoints.",
  "Error Recovery": "When correcting the AI, be specific: 'In file X, line Y, change Z to W' not 'no, wrong'.",
  "Workspace Hygiene": "Maintain CLAUDE.md and .claude/ workspace docs for project context.",
  "Cross-Session Continuity": "Start each session by reading project context files (CLAUDE.md, README, etc.).",
  "Verification": "Always run tests/build at the end of a session to verify changes work.",
};

function buildTrendReport(sessions: ParsedSession[], project: string, period: string): TrendReport {
  const dailyScores = scoreDailyData(sessions);
  const baseline = loadBaseline(project);

  // Category trends: compare first half vs second half
  const mid = Math.floor(dailyScores.length / 2);
  const firstHalf = dailyScores.slice(0, Math.max(1, mid));
  const secondHalf = dailyScores.slice(Math.max(1, mid));

  const categoryNames = dailyScores[0]?.categories.map((c) => c.name) ?? [];
  const categoryTrends = categoryNames.map((name) => {
    const avgFirst = firstHalf.reduce((s, d) => s + (d.categories.find((c) => c.name === name)?.score ?? 0), 0) / (firstHalf.length || 1);
    const avgSecond = secondHalf.reduce((s, d) => s + (d.categories.find((c) => c.name === name)?.score ?? 0), 0) / (secondHalf.length || 1);
    return { name, current: Math.round(avgSecond), previous: Math.round(avgFirst), arrow: trendArrow(avgSecond, avgFirst) };
  });

  // Top 3 to improve
  const sorted = [...categoryTrends].sort((a, b) => a.current - b.current);
  const top3Improve = sorted.slice(0, 3).map((t) => ({
    category: t.name,
    score: t.current,
    recommendation: IMPROVEMENT_TIPS[t.name] ?? "Focus on improving this area.",
  }));

  const { best, worst } = findBestWorstPrompt(sessions);

  const totalPrompts = sessions.reduce((s, d) => s + d.userMessages.length, 0);
  const totalCorrections = sessions.reduce((s, d) => s + d.corrections.length, 0);

  return {
    project,
    period,
    dailyScores,
    categoryTrends,
    top3Improve,
    bestPrompt: best,
    worstPrompt: worst,
    stats: {
      sessions: sessions.length,
      prompts: totalPrompts,
      toolCalls: sessions.reduce((s, d) => s + d.toolCalls.length, 0),
      correctionRate: totalPrompts > 0 ? Math.round((totalCorrections / totalPrompts) * 100) : 0,
      compactions: sessions.reduce((s, d) => s + d.compactions.length, 0),
    },
    baseline,
    svg: generateTrendSVG(dailyScores.map((d) => ({ date: d.date, score: d.score }))),
  };
}

function trendToMarkdown(tr: TrendReport): string {
  const lines: string[] = [];
  const periodLabel = tr.period === "week" ? "Weekly" : "Monthly";
  lines.push(`# 📈 ${periodLabel} Trend Report`);
  lines.push(`**Project:** ${tr.project} | **Period:** ${tr.period} | **Days:** ${tr.dailyScores.length}\n`);

  lines.push(`## 📊 Stats`);
  lines.push(`| Sessions | Prompts | Tool Calls | Correction Rate | Compactions |`);
  lines.push(`|----------|---------|------------|-----------------|-------------|`);
  lines.push(`| ${tr.stats.sessions} | ${tr.stats.prompts} | ${tr.stats.toolCalls} | ${tr.stats.correctionRate}% | ${tr.stats.compactions} |\n`);

  lines.push(`## 📉 Score Trend`);
  lines.push(`| Date | Score | Grade |`);
  lines.push(`|------|-------|-------|`);
  for (const d of tr.dailyScores) {
    lines.push(`| ${d.date} | ${d.score} | ${letterGrade(d.score)} |`);
  }

  lines.push(`\n## Category Trends`);
  lines.push(`| Category | Score | Trend |${tr.baseline ? " vs Avg |" : ""}`);
  lines.push(`|----------|-------|-------|${tr.baseline ? "--------|" : ""}`);
  for (const t of tr.categoryTrends) {
    let row = `| ${t.name} | ${t.current} (${letterGrade(t.current)}) | ${t.arrow} |`;
    if (tr.baseline) {
      const avg = tr.baseline.categoryAverages[t.name];
      if (avg != null) row += ` ${trendArrow(t.current, avg)} vs ${letterGrade(avg)} (${avg}) |`;
      else row += ` — |`;
    }
    lines.push(row);
  }

  lines.push(`\n## 🎯 Top 3 Areas to Improve`);
  for (const t of tr.top3Improve) {
    lines.push(`- **${t.category}** (${letterGrade(t.score)}, ${t.score}/100): ${t.recommendation}`);
  }

  lines.push(`\n## 💬 Prompts of the ${tr.period === "week" ? "Week" : "Month"}`);
  lines.push(`**Best prompt:**\n> ${tr.bestPrompt}\n`);
  lines.push(`**Worst prompt:**\n> ${tr.worstPrompt}`);

  return lines.join("\n");
}

function trendToHTML(tr: TrendReport): string {
  const periodLabel = tr.period === "week" ? "Weekly" : "Monthly";
  const categoryRows = tr.categoryTrends.map((t) => {
    const color = gradeColor(letterGrade(t.current));
    const baselineCol = tr.baseline ? `<td style="padding:6px;text-align:center">${tr.baseline.categoryAverages[t.name] != null ? `${trendArrow(t.current, tr.baseline.categoryAverages[t.name]!)} ${letterGrade(tr.baseline.categoryAverages[t.name]!)}` : "—"}</td>` : "";
    return `<tr><td style="padding:6px">${t.name}</td><td style="padding:6px;text-align:center"><span style="background:${color};color:white;padding:2px 6px;border-radius:3px">${letterGrade(t.current)} (${t.current})</span></td><td style="padding:6px;text-align:center;font-size:18px">${t.arrow}</td>${baselineCol}</tr>`;
  }).join("");

  return `<!DOCTYPE html><html><head><meta charset="utf-8"/></head><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;margin:0;color:#1f2937">
  <div style="background:linear-gradient(135deg,#1e293b,#0f172a);color:white;padding:32px 40px">
    <h1 style="margin:0">📈 ${periodLabel} Trend Report</h1>
    <p style="margin:8px 0 0;opacity:0.8">Project: <strong>${tr.project}</strong> | ${tr.dailyScores.length} days | ${tr.stats.sessions} sessions</p>
  </div>
  <div style="padding:24px 40px;display:flex;gap:20px;flex-wrap:wrap">
    <div style="background:#f8fafc;padding:12px 20px;border-radius:8px;text-align:center"><div style="font-size:24px;font-weight:700">${tr.stats.sessions}</div><div style="color:#6b7280;font-size:12px">Sessions</div></div>
    <div style="background:#f8fafc;padding:12px 20px;border-radius:8px;text-align:center"><div style="font-size:24px;font-weight:700">${tr.stats.prompts}</div><div style="color:#6b7280;font-size:12px">Prompts</div></div>
    <div style="background:#f8fafc;padding:12px 20px;border-radius:8px;text-align:center"><div style="font-size:24px;font-weight:700">${tr.stats.toolCalls}</div><div style="color:#6b7280;font-size:12px">Tool Calls</div></div>
    <div style="background:#f8fafc;padding:12px 20px;border-radius:8px;text-align:center"><div style="font-size:24px;font-weight:700">${tr.stats.correctionRate}%</div><div style="color:#6b7280;font-size:12px">Correction Rate</div></div>
    <div style="background:#f8fafc;padding:12px 20px;border-radius:8px;text-align:center"><div style="font-size:24px;font-weight:700">${tr.stats.compactions}</div><div style="color:#6b7280;font-size:12px">Compactions</div></div>
  </div>
  <div style="padding:0 40px">${tr.svg}</div>
  <div style="padding:24px 40px">
    <h2>Category Trends</h2>
    <table style="width:100%;border-collapse:collapse;font-size:14px">
      <thead><tr style="background:#f9fafb"><th style="padding:6px;text-align:left">Category</th><th style="padding:6px;text-align:center">Score</th><th style="padding:6px;text-align:center">Trend</th>${tr.baseline ? '<th style="padding:6px;text-align:center">vs Avg</th>' : ""}</tr></thead>
      <tbody>${categoryRows}</tbody>
    </table>
  </div>
  <div style="padding:0 40px 20px">
    <h2>🎯 Top 3 Areas to Improve</h2>
    ${tr.top3Improve.map((t) => `<div style="background:#fef2f2;border-left:4px solid #f97316;padding:10px 16px;margin-bottom:8px;border-radius:4px"><strong>${t.category}</strong> (${t.score}/100): ${t.recommendation}</div>`).join("")}
  </div>
  <div style="padding:0 40px 40px">
    <h2>💬 Prompts of the ${tr.period === "week" ? "Week" : "Month"}</h2>
    <div style="background:#f0fdf4;border-left:4px solid #22c55e;padding:10px 16px;margin-bottom:8px;border-radius:4px"><strong>Best:</strong> ${tr.bestPrompt}</div>
    <div style="background:#fef2f2;border-left:4px solid #ef4444;padding:10px 16px;border-radius:4px"><strong>Worst:</strong> ${tr.worstPrompt}</div>
  </div>
</body></html>`;
}

// ── Comparative Report ─────────────────────────────────────────────────────

interface ComparativeReport {
  period: string;
  date: string;
  projects: { name: string; scorecard: Scorecard }[];
  patterns: string[];
}

function buildComparativeReport(projectNames: string[], period: string, since?: string): ComparativeReport {
  const projects: { name: string; scorecard: Scorecard }[] = [];

  for (const pName of projectNames) {
    const sessions = loadSessions({ project: pName, period, since });
    if (sessions.length === 0) continue;
    const sc = computeScorecard(sessions, pName, period);
    projects.push({ name: pName, scorecard: sc });
  }

  // Cross-project patterns
  const patterns: string[] = [];
  if (projects.length >= 2) {
    const categoryNames = projects[0]?.scorecard.categories.map((c) => c.name) ?? [];
    for (const catName of categoryNames) {
      const scores = projects.map((p) => p.scorecard.categories.find((c) => c.name === catName)?.score ?? 0);
      const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
      const allLow = scores.every((s) => s < 65);
      const allHigh = scores.every((s) => s >= 80);
      if (allLow) patterns.push(`⚠️ You're consistently weakest at ${catName} across all projects (avg: ${Math.round(avg)})`);
      if (allHigh) patterns.push(`✅ ${catName} score is strong everywhere — good habit (avg: ${Math.round(avg)})`);
    }
  }

  return { period, date: new Date().toISOString().slice(0, 10), projects, patterns };
}

function comparativeToMarkdown(cr: ComparativeReport): string {
  const lines: string[] = [];
  lines.push(`# 📊 Comparative Report — ${cr.date}`);
  lines.push(`**Period:** ${cr.period} | **Projects:** ${cr.projects.length}\n`);

  if (cr.projects.length === 0) return lines.join("\n") + "\nNo projects with data found.";

  const catNames = cr.projects[0].scorecard.categories.map((c) => c.name);
  const nameHeader = cr.projects.map((p) => p.name.padEnd(14)).join("  ");
  lines.push(`${"".padEnd(24)}${nameHeader}`);

  // Overall
  const overallRow = cr.projects.map((p) => `${p.scorecard.overallGrade} (${p.scorecard.overall})`.padEnd(14)).join("  ");
  lines.push(`${"Overall:".padEnd(24)}${overallRow}`);

  for (const catName of catNames) {
    const row = cr.projects.map((p) => {
      const c = p.scorecard.categories.find((x) => x.name === catName);
      return c ? `${c.grade} (${c.score})`.padEnd(14) : "—".padEnd(14);
    }).join("  ");
    lines.push(`${(catName + ":").padEnd(24)}${row}`);
  }

  if (cr.patterns.length > 0) {
    lines.push(`\n## Cross-project patterns`);
    for (const p of cr.patterns) lines.push(p);
  }

  return lines.join("\n");
}

function comparativeToHTML(cr: ComparativeReport): string {
  if (cr.projects.length === 0) return "<html><body>No data</body></html>";
  const catNames = cr.projects[0].scorecard.categories.map((c) => c.name);

  const headerCols = cr.projects.map((p) => `<th style="padding:8px;text-align:center">${p.name}</th>`).join("");
  const overallCols = cr.projects.map((p) => {
    const c = gradeColor(p.scorecard.overallGrade);
    return `<td style="padding:8px;text-align:center"><span style="background:${c};color:white;padding:2px 8px;border-radius:4px;font-weight:700">${p.scorecard.overallGrade} (${p.scorecard.overall})</span></td>`;
  }).join("");

  const rows = catNames.map((catName) => {
    const cols = cr.projects.map((p) => {
      const cat = p.scorecard.categories.find((x) => x.name === catName);
      if (!cat) return `<td style="padding:6px;text-align:center">—</td>`;
      const c = gradeColor(cat.grade);
      return `<td style="padding:6px;text-align:center"><span style="background:${c};color:white;padding:1px 6px;border-radius:3px;font-size:13px">${cat.grade} (${cat.score})</span></td>`;
    }).join("");
    return `<tr><td style="padding:6px;font-weight:600">${catName}</td>${cols}</tr>`;
  }).join("");

  const patternsHTML = cr.patterns.map((p) => `<div style="padding:8px 16px;margin-bottom:4px;background:${p.startsWith("⚠️") ? "#fef2f2" : "#f0fdf4"};border-radius:4px">${p}</div>`).join("");

  return `<!DOCTYPE html><html><head><meta charset="utf-8"/></head><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;margin:0;color:#1f2937">
  <div style="background:linear-gradient(135deg,#1e293b,#0f172a);color:white;padding:32px 40px">
    <h1 style="margin:0">📊 Comparative Report</h1>
    <p style="margin:8px 0 0;opacity:0.8">Period: ${cr.period} | ${cr.date}</p>
  </div>
  <div style="padding:24px 40px">
    <table style="width:100%;border-collapse:collapse;font-size:14px">
      <thead><tr style="background:#f9fafb"><th style="padding:8px;text-align:left">Category</th>${headerCols}</tr></thead>
      <tbody>
        <tr style="background:#f0f9ff"><td style="padding:8px;font-weight:700">Overall</td>${overallCols}</tr>
        ${rows}
      </tbody>
    </table>
  </div>
  ${cr.patterns.length ? `<div style="padding:0 40px 40px"><h2>Cross-project Patterns</h2>${patternsHTML}</div>` : ""}
</body></html>`;
}

// ── Enhanced Markdown with baseline ────────────────────────────────────────

function toMarkdownWithBaseline(sc: Scorecard, baseline: BaselineData | null): string {
  const lines: string[] = [];
  lines.push(`# 📊 Prompt Discipline Scorecard`);
  lines.push(`**Project:** ${sc.project} | **Period:** ${sc.period} (${sc.date}) | **Overall: ${sc.overallGrade} (${sc.overall}/100)**\n`);

  lines.push(`## Category Scores`);
  if (baseline) {
    lines.push(`| # | Category | Score | Grade | vs Avg |`);
    lines.push(`|---|----------|-------|-------|--------|`);
    sc.categories.forEach((c, i) => {
      const avg = baseline.categoryAverages[c.name];
      const avgCol = avg != null ? `${trendArrow(c.score, avg)} ${letterGrade(avg)} (${avg})` : "—";
      lines.push(`| ${i + 1} | ${c.name} | ${c.score} | ${c.grade} | ${avgCol} |`);
    });
  } else {
    lines.push(`| # | Category | Score | Grade |`);
    lines.push(`|---|----------|-------|-------|`);
    sc.categories.forEach((c, i) => {
      lines.push(`| ${i + 1} | ${c.name} | ${c.score} | ${c.grade} |`);
    });
  }

  lines.push(`\n## Highlights`);
  lines.push(`- 🏆 **Best:** ${sc.highlights.best.name} (${sc.highlights.best.grade}) — ${sc.highlights.best.evidence}`);
  lines.push(`- ⚠️ **Worst:** ${sc.highlights.worst.name} (${sc.highlights.worst.grade}) — ${sc.highlights.worst.evidence}`);

  lines.push(`\n## Detailed Breakdown`);
  sc.categories.forEach((c, i) => {
    lines.push(`\n### ${i + 1}. ${c.name} — ${c.grade} (${c.score}/100)`);
    lines.push(`Evidence: ${c.evidence}`);
    if (c.examples?.bad?.length) {
      lines.push(`\nExamples of vague follow-ups:`);
      c.examples.bad.forEach((e) => lines.push(`- ❌ "${e}"`));
    }
    if (c.examples?.good?.length) {
      lines.push(`\nExamples of specific follow-ups:`);
      c.examples.good.forEach((e) => lines.push(`- ✅ "${e}"`));
    }
  });

  return lines.join("\n");
}

// ── Tool Registration ──────────────────────────────────────────────────────

export function registerGenerateScorecard(server: McpServer): void {
  server.tool(
    "generate_scorecard",
    "Generate a prompt discipline scorecard, trend report, or comparative report. Analyzes sessions across 12 categories with PDF/Markdown output, trend lines, and cross-project comparisons.",
    {
      project: z.string().optional().describe("Project name to score. If omitted, scores current project."),
      period: z.enum(["session", "day", "week", "month"]).default("day"),
      session_id: z.string().optional().describe("Score a specific session by ID"),
      since: z.string().optional().describe("Start date (ISO or relative like '7days')"),
      output: z.enum(["pdf", "markdown"]).default("markdown"),
      output_path: z.string().optional().describe("Where to save PDF. Default: /tmp/scorecard-{date}.pdf"),
      report_type: z.enum(["scorecard", "trend", "comparative"]).default("scorecard").describe("Type of report: scorecard (default), trend (week/month analysis), or comparative (cross-project)"),
      compare_projects: z.array(z.string()).optional().describe("Project names for comparative report"),
    },
    async (params) => {
      const date = new Date().toISOString().slice(0, 10);

      // ── Comparative Report ──
      if (params.report_type === "comparative") {
        const projects = params.compare_projects ?? [];
        if (projects.length < 2) {
          return { content: [{ type: "text" as const, text: "Comparative report requires at least 2 projects in compare_projects." }] };
        }
        const cr = buildComparativeReport(projects, params.period, params.since);
        if (params.output === "pdf") {
          const html = comparativeToHTML(cr);
          const outputPath = params.output_path ?? `/tmp/comparative-${date}.pdf`;
          try {
            await generatePDF(html, outputPath);
            return { content: [{ type: "text" as const, text: `✅ Comparative PDF saved to ${outputPath}\n\n${comparativeToMarkdown(cr)}` }] };
          } catch (err) {
            return { content: [{ type: "text" as const, text: `⚠️ PDF failed (${err}). Markdown:\n\n${comparativeToMarkdown(cr)}` }] };
          }
        }
        return { content: [{ type: "text" as const, text: comparativeToMarkdown(cr) }] };
      }

      // ── Load sessions ──
      const sessions = loadSessions({
        project: params.project,
        sessionId: params.session_id,
        since: params.since,
        period: params.period,
      });

      if (sessions.length === 0) {
        return { content: [{ type: "text" as const, text: "No sessions found matching the criteria. Try broadening the time period or checking the project name." }] };
      }

      const projectName = params.project ?? sessions[0]?.events[0]?.project_name ?? "unknown";

      // ── Trend Report ──
      if (params.report_type === "trend" || (params.report_type === "scorecard" && (params.period === "week" || params.period === "month") && !params.session_id)) {
        // For week/month periods, auto-generate trend if report_type is scorecard
        // but only if not requesting a specific session
        if (params.report_type !== "trend" && params.period !== "week" && params.period !== "month") {
          // Fall through to regular scorecard
        } else {
          const tr = buildTrendReport(sessions, projectName, params.period);
          // Also update baseline
          const overallSc = computeScorecard(sessions, projectName, params.period);
          updateBaseline(projectName, overallSc);

          if (params.output === "pdf") {
            const html = trendToHTML(tr);
            const outputPath = params.output_path ?? `/tmp/trend-${date}.pdf`;
            try {
              await generatePDF(html, outputPath);
              return { content: [{ type: "text" as const, text: `✅ Trend PDF saved to ${outputPath}\n\n${trendToMarkdown(tr)}` }] };
            } catch (err) {
              return { content: [{ type: "text" as const, text: `⚠️ PDF failed (${err}). Markdown:\n\n${trendToMarkdown(tr)}` }] };
            }
          }
          return { content: [{ type: "text" as const, text: trendToMarkdown(tr) }] };
        }
      }

      // ── Regular Scorecard ──
      const scorecard = computeScorecard(sessions, projectName, params.period);
      const baseline = loadBaseline(projectName);
      updateBaseline(projectName, scorecard);

      if (params.output === "pdf") {
        const html = toHTML(scorecard);
        const outputPath = params.output_path ?? `/tmp/scorecard-${date}.pdf`;
        try {
          await generatePDF(html, outputPath);
          return { content: [{ type: "text" as const, text: `✅ PDF scorecard saved to ${outputPath}\n\n${toMarkdownWithBaseline(scorecard, baseline)}` }] };
        } catch (err) {
          return { content: [{ type: "text" as const, text: `⚠️ PDF generation failed (${err}). Falling back to markdown:\n\n${toMarkdownWithBaseline(scorecard, baseline)}` }] };
        }
      }

      return { content: [{ type: "text" as const, text: toMarkdownWithBaseline(scorecard, baseline) }] };
    },
  );
}
