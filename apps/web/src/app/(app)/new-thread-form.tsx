"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent, type ReactNode } from "react";
import type { AgentKind, CreateThreadRequest, PolicyDenied, SandboxSize, ThreadMode } from "@lemonlime/protocol";
import { DeniedNotice } from "@/components/denied-notice.tsx";
import { apiFetch } from "@/lib/api-client.ts";
import type { ThreadResponse } from "@/lib/threads.ts";

const AGENTS: Array<{ value: AgentKind; label: string }> = [
  { value: "claude-code", label: "Claude Code" },
  { value: "codex", label: "Codex" },
  { value: "opencode", label: "OpenCode" },
  { value: "acp", label: "Other ACP agent" },
];

function Segmented<T extends string>({
  name,
  value,
  onChange,
  options,
}: {
  name: string;
  value: T;
  onChange: (v: T) => void;
  options: Array<{ value: T; label: ReactNode; hint?: string }>;
}) {
  return (
    <div role="radiogroup" aria-label={name} className="grid grid-cols-2 gap-1 rounded-lg border border-line bg-cream p-1">
      {options.map(o => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={`rounded-md px-3 py-1.5 text-left text-sm transition-colors ${
            value === o.value ? "bg-paper font-medium text-ink shadow-sm" : "text-muted hover:text-ink"
          }`}
        >
          {o.label}
          {o.hint && <span className="block text-xs font-normal text-muted">{o.hint}</span>}
        </button>
      ))}
    </div>
  );
}

export function NewThreadForm() {
  const router = useRouter();
  const [agent, setAgent] = useState<AgentKind>("claude-code");
  const [acpCommand, setAcpCommand] = useState("");
  const [model, setModel] = useState("");
  const [repoUrl, setRepoUrl] = useState("");
  const [baseBranch, setBaseBranch] = useState("main");
  const [mode, setMode] = useState<ThreadMode>("cloud");
  const [size, setSize] = useState<SandboxSize>("small");
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [denied, setDenied] = useState<PolicyDenied | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setDenied(null);
    const body: CreateThreadRequest = {
      agent: {
        kind: agent,
        ...(agent === "acp" ? { command: acpCommand.trim().split(/\s+/).filter(Boolean) } : {}),
        ...(model.trim() ? { model: model.trim() } : {}),
      },
      repo: { url: repoUrl.trim(), baseBranch: baseBranch.trim() || "main" },
      mode,
      sandboxSize: size,
      ...(prompt.trim() ? { prompt: prompt.trim() } : {}),
    };
    const res = await apiFetch<ThreadResponse>("/api/threads", { method: "POST", body });
    if (res.ok) {
      router.push(`/threads/${res.data.thread.id}`);
      router.refresh();
      return;
    }
    setBusy(false);
    if (res.denied) setDenied(res.denied);
    else setError(res.message);
  }

  return (
    <form onSubmit={submit} className="mt-5 space-y-4">
      <div>
        <label htmlFor="agent" className="label">Agent</label>
        <select id="agent" className="field" value={agent} onChange={e => setAgent(e.target.value as AgentKind)}>
          {AGENTS.map(a => (
            <option key={a.value} value={a.value}>{a.label}</option>
          ))}
        </select>
      </div>
      {agent === "acp" && (
        <div>
          <label htmlFor="acp-command" className="label">Agent command</label>
          <input
            id="acp-command"
            required
            className="field font-mono"
            placeholder="gemini --experimental-acp"
            value={acpCommand}
            onChange={e => setAcpCommand(e.target.value)}
          />
        </div>
      )}
      <div>
        <label htmlFor="model" className="label">
          Model <span className="font-normal text-muted">(optional)</span>
        </label>
        <input id="model" className="field" placeholder="Agent default" value={model} onChange={e => setModel(e.target.value)} />
      </div>
      <div>
        <label htmlFor="repo" className="label">Repository</label>
        <input
          id="repo"
          required
          className="field"
          placeholder={mode === "cloud" ? "https://github.com/you/project.git" : "/path/to/project"}
          value={repoUrl}
          onChange={e => setRepoUrl(e.target.value)}
        />
      </div>
      <div>
        <label htmlFor="base" className="label">Base branch</label>
        <input id="base" required className="field font-mono" value={baseBranch} onChange={e => setBaseBranch(e.target.value)} />
      </div>
      <div>
        <span className="label">Where it runs</span>
        <Segmented
          name="Where it runs"
          value={mode}
          onChange={setMode}
          options={[
            { value: "cloud", label: "Cloud", hint: "Isolated sandbox" },
            { value: "local", label: "This computer", hint: "Via the desktop app" },
          ]}
        />
      </div>
      {mode === "cloud" && (
        <div>
          <span className="label">Sandbox size</span>
          <Segmented
            name="Sandbox size"
            value={size}
            onChange={setSize}
            options={[
              { value: "small", label: "Small", hint: "1 vCPU · 2 GB" },
              { value: "large", label: "Large", hint: "2 vCPU · 4 GB" },
            ]}
          />
        </div>
      )}
      <div>
        <label htmlFor="prompt" className="label">First message</label>
        <textarea
          id="prompt"
          rows={4}
          className="field h-auto resize-y py-2 leading-relaxed"
          placeholder="What should the agent do?"
          value={prompt}
          onChange={e => setPrompt(e.target.value)}
        />
      </div>
      {error && (
        <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>
      )}
      {denied && <DeniedNotice denied={denied} onDismiss={() => setDenied(null)} />}
      <button type="submit" className="btn-lemon w-full" disabled={busy}>
        {busy ? (mode === "cloud" ? "Starting sandbox..." : "Creating...") : "Start thread"}
      </button>
    </form>
  );
}
