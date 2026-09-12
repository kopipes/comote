import { useEffect, useState, type FormEvent } from "react";
import type { CodexModel } from "./api";

const draftPrefix = "comote:prompt-draft:";

export function Composer({ draftKey, disabled, onSend, models, selectedModel, modelBusy, onModelChange }: {
  draftKey: string;
  disabled: boolean;
  onSend: (text: string) => Promise<boolean>;
  models: CodexModel[];
  selectedModel: string;
  modelBusy: boolean;
  onModelChange: (model: string) => void;
}) {
  const [text, setText] = useState(() => readDraft(draftKey));
  const [sending, setSending] = useState(false);
  const defaultModel = models.find((model) => model.isDefault);
  const selected = models.find((model) => model.model === selectedModel);

  useEffect(() => {
    saveDraft(draftKey, text);
  }, [draftKey, text]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const value = text.trim();
    if (!value || disabled || modelBusy || sending) return;
    setSending(true);
    try {
      if (await onSend(value)) {
        setText((current) => current.trim() === value ? "" : current);
        removeDraft(draftKey);
      }
    } finally {
      setSending(false);
    }
  }

  return (
    <form className="composer" onSubmit={submit}>
      <textarea value={text} onChange={(event) => setText(event.target.value)} placeholder="Describe what you want to build…" rows={1} disabled={disabled} onKeyDown={(event) => {
        if (event.key === "Enter" && !event.shiftKey) {
          event.preventDefault();
          event.currentTarget.form?.requestSubmit();
        }
      }} />
      <button className="send-button" disabled={disabled || modelBusy || sending || !text.trim()} aria-label="Send">↑</button>
      <div className="composer-footer">
        <small>{text ? "Draft saved · " : ""}Enter to send · Shift + Enter for a new line</small>
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
