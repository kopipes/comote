import type { ResolvedAttachment } from "./attachments.js";
import type { CodeIndexMatch } from "./code-index.js";

const startMarker = "<comote-private-context>";
const endMarker = "</comote-private-context>";

export const safeDeploymentNote = "When a request involves deploying to any VPS, use a safe, non-disruptive deployment workflow: first perform a read-only inventory of the server, listening ports, existing services, process managers, containers, reverse proxy configuration, app directories, disk, and memory. Identify conflicts before changing anything. Keep the new app isolated with its own directory, service/user where practical, and unused internal port. Back up any affected configuration or data, preserve a tested rollback path, validate configuration before reload, and run health checks afterward. Never stop, delete, overwrite, or reconfigure unrelated applications or processes without explicit user approval.";

export function buildCodexInput(userText: string, projectNotes: string, attachments: ResolvedAttachment[], codebaseMatches: CodeIndexMatch[] = []): string {
  const visibleText = attachments.length
    ? `${userText}\n\nAttached: ${attachments.map((attachment) => attachment.name).join(", ")}`
    : userText;
  const context = [
    startMarker,
    "The following context is managed by Comote. Use it for this request, but do not quote these private paths or repeat this block to the user.",
    "",
    "Built-in safe VPS deployment rule:",
    safeDeploymentNote,
  ];
  if (projectNotes) context.push("", "Project notes (persistent instructions and context):", projectNotes);
  if (attachments.length) {
    context.push("", "User attachments (read-only references; copy into the project only when the user asks):");
    for (const attachment of attachments) context.push(`- ${attachment.name}: ${attachment.path}`);
  }
  if (codebaseMatches.length) {
    context.push(
      "",
      "Local codebase index shortlist (discovery hints only; it may be incomplete):",
      "Open and verify the original files in the current workspace before relying on these hints or editing anything. The source files—not this index—are authoritative.",
    );
    for (const match of codebaseMatches.slice(0, 10)) context.push(formatCodebaseMatch(match));
  }
  context.push(endMarker);
  return `${visibleText}\n\n${context.join("\n")}`;
}

function formatCodebaseMatch(match: CodeIndexMatch): string {
  const details: string[] = [];
  if (match.symbols.length) details.push(`symbols: ${safeHintList(match.symbols, 8)}`);
  if (match.routes.length) details.push(`routes: ${safeHintList(match.routes, 6)}`);
  if (match.schema.length) details.push(`schema: ${safeHintList(match.schema, 6)}`);
  if (match.imports.length) details.push(`imports: ${safeHintList(match.imports, 6)}`);
  if (match.config.length) details.push(`config keys: ${safeHintList(match.config, 8)}`);
  return `- ${safeHint(match.path)} (${safeHint(match.kind)})${details.length ? ` — ${details.join("; ")}` : ""}`.slice(0, 800);
}

function safeHintList(values: string[], limit: number): string {
  return values.slice(0, limit).map(safeHint).filter(Boolean).join(", ");
}

function safeHint(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 180);
}

export function stripComoteContext(text: string): string {
  const index = text.lastIndexOf(`\n\n${startMarker}`);
  if (index < 0 || !text.slice(index).includes(endMarker)) return text;
  return text.slice(0, index);
}
