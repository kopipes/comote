import type { ResolvedAttachment } from "./attachments.js";

const startMarker = "<comote-private-context>";
const endMarker = "</comote-private-context>";

export const safeDeploymentNote = "When a request involves deploying to any VPS, use a safe, non-disruptive deployment workflow: first perform a read-only inventory of the server, listening ports, existing services, process managers, containers, reverse proxy configuration, app directories, disk, and memory. Identify conflicts before changing anything. Keep the new app isolated with its own directory, service/user where practical, and unused internal port. Back up any affected configuration or data, preserve a tested rollback path, validate configuration before reload, and run health checks afterward. Never stop, delete, overwrite, or reconfigure unrelated applications or processes without explicit user approval.";

export function buildCodexInput(userText: string, projectNotes: string, attachments: ResolvedAttachment[]): string {
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
  context.push(endMarker);
  return `${visibleText}\n\n${context.join("\n")}`;
}

export function stripComoteContext(text: string): string {
  const index = text.lastIndexOf(`\n\n${startMarker}`);
  if (index < 0 || !text.slice(index).includes(endMarker)) return text;
  return text.slice(0, index);
}
