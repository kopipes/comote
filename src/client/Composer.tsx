import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, type Attachment, type CodexModel } from "./api";

const draftPrefix = "comote:prompt-draft:";

export function Composer({ projectId, threadId, draftKey, disabled, onSend, onError, models, selectedModel, modelBusy, onModelChange }: {
  projectId: string;
  threadId: string;
  draftKey: string;
  disabled: boolean;
  onSend: (text: string, attachments?: Attachment[]) => Promise<boolean>;
  onError: (message: string) => void;
  models: CodexModel[];
  selectedModel: string;
  modelBusy: boolean;
  onModelChange: (model: string) => void;
}) {
  const [text, setText] = useState(() => readDraft(draftKey));
  const [sending, setSending] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);
  const defaultModel = models.find((model) => model.isDefault);
  const selected = models.find((model) => model.model === selectedModel);

  useEffect(() => {
    saveDraft(draftKey, text);
  }, [draftKey, text]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const value = text.trim() || (attachments.length ? "Review the attached file(s) and help me with the next appropriate step." : "");
    if (!value || disabled || modelBusy || sending || uploading) return;
    setSending(true);
    try {
      if (await onSend(value, attachments)) {
        setText((current) => current.trim() === value ? "" : current);
        setAttachments([]);
        removeDraft(draftKey);
      }
    } finally {
      setSending(false);
    }
  }

  async function uploadFiles(files: FileList | null) {
    if (!files?.length) return;
    const remaining = 5 - attachments.length;
    if (remaining <= 0) {
      onError("You can attach up to 5 files to one message.");
      return;
    }
    setUploading(true);
    try {
      for (const file of Array.from(files).slice(0, remaining)) {
        const result = await api.upload<{ attachment: Attachment }>(`/api/projects/${projectId}/threads/${threadId}/attachments`, file);
        setAttachments((current) => [...current, result.attachment]);
      }
    } catch (cause) {
      onError((cause as Error).message);
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  async function removeAttachment(attachment: Attachment) {
    try {
      await api.post(`/api/projects/${projectId}/threads/${threadId}/attachments/${attachment.id}/delete`);
      setAttachments((current) => current.filter((item) => item.id !== attachment.id));
    } catch (cause) {
      onError((cause as Error).message);
    }
  }

  return (
    <form className="composer" onSubmit={submit}>
      {attachments.length > 0 && <div className="attachment-list">{attachments.map((attachment) => (
        <button key={attachment.id} type="button" onClick={() => void removeAttachment(attachment)} disabled={sending} title={`Remove ${attachment.name}`}>
          <span>{attachment.name}</span><small>{formatSize(attachment.size)} · ×</small>
        </button>
      ))}</div>}
      <textarea value={text} onChange={(event) => setText(event.target.value)} placeholder="Describe what you want to build…" rows={1} disabled={disabled} onKeyDown={(event) => {
        if (event.key === "Enter" && !event.shiftKey) {
          event.preventDefault();
          event.currentTarget.form?.requestSubmit();
        }
      }} />
      <button className="send-button" disabled={disabled || modelBusy || sending || uploading || (!text.trim() && !attachments.length)} aria-label="Send">↑</button>
      <div className="composer-footer">
        <div className="composer-tools">
          <input ref={fileInput} type="file" multiple hidden accept="image/png,image/jpeg,image/webp,image/gif,application/pdf,text/plain,text/csv,application/json,.md,.markdown,.yaml,.yml,.xml,.js,.jsx,.ts,.tsx,.css,.scss,.html,.sql,.py,.rb,.go,.rs,.java,.kt,.swift,.php,.sh" onChange={(event) => void uploadFiles(event.target.files)} />
          <button className="attach-button" type="button" onClick={() => fileInput.current?.click()} disabled={disabled || sending || uploading || attachments.length >= 5}>{uploading ? "Uploading…" : "+ File"}</button>
          <small>{text ? "Draft saved · " : ""}Enter to send · Shift + Enter for a new line</small>
        </div>
        <label className="model-picker" title={selected?.description || defaultModel?.description || "Use the default model selected by Codex."}>
          <span>Model</span>
          <select value={selectedModel} disabled={disabled || modelBusy || sending} onChange={(event) => onModelChange(event.target.value)} aria-label="Codex model for this session">
            <option value="">{defaultModel ? `Auto · ${defaultModel.displayName}` : "Auto"}</option>
            {selectedModel && !selected && <option value={selectedModel}>{selectedModel} · unavailable</option>}
            {models.map((model) => <option key={model.model} value={model.model}>{model.displayName}</option>)}
          </select>
        </label>
      </div>
    </form>
  );
}

function formatSize(bytes: number): string {
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function draftStorageKey(projectId: string, threadId: string): string {
  return `${projectId}:${threadId}`;
}

function readDraft(key: string): string {
  try {
    return window.localStorage.getItem(`${draftPrefix}${key}`) ?? "";
  } catch {
    return "";
  }
}

function saveDraft(key: string, value: string): void {
  try {
    if (value) window.localStorage.setItem(`${draftPrefix}${key}`, value.slice(0, 20_000));
    else window.localStorage.removeItem(`${draftPrefix}${key}`);
  } catch { /* storage can be unavailable in private browser modes */ }
}

function removeDraft(key: string): void {
  try { window.localStorage.removeItem(`${draftPrefix}${key}`); } catch { /* ignore unavailable storage */ }
}
