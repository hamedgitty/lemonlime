"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
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

  const STARTERS = [
    ["Find and fix a bug", "Look through this repository for a real bug, explain it, fix it, and add a test that would have caught it."],
    ["Add missing tests", "Find the most important code in this repository that has no tests, and write good tests for it. Run them."],
    ["Explain this codebase", "Explain how this codebase fits together: the main parts, how data flows, and where I should start reading."],
    ["Review the last commit", "Review the most recent commit on this branch like a careful senior engineer. List real problems, most important first."],
  ] as const;
  const pill = "h-8 rounded-lg bg-transparent px-2 text-sm font-medium text-ink hover:bg-cream-deep focus-visible:bg-cream-deep";
  const canSend = !busy && prompt.trim().length > 0 && repoUrl.trim().length > 0 && (agent !== "acp" || acpCommand.trim().length > 0);

  return (
    <form onSubmit={submit}>
      <div className="rounded-xl border border-line bg-paper shadow-[0_1px_2px_rgb(23_32_14/0.04),0_4px_16px_rgb(23_32_14/0.05)] focus-within:border-control">
        <label htmlFor="prompt" className="sr-only">
          What should the agent do?
        </label>
        <textarea
          id="prompt"
          rows={3}
          autoFocus
          className="block w-full resize-none bg-transparent px-4 pt-3.5 text-[15px] leading-relaxed outline-none placeholder:text-faint"
          placeholder="Ask the agent to build anything…"
          value={prompt}
          onChange={e => setPrompt(e.target.value)}
          onKeyDown={e => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              if (canSend) e.currentTarget.form?.requestSubmit();
            }
          }}
        />
        <div className="flex flex-wrap items-center gap-1 px-2.5 pt-1 pb-2.5">
          <label htmlFor="agent" className="sr-only">
            Agent
          </label>
          <select id="agent" className={pill} value={agent} onChange={e => setAgent(e.target.value as AgentKind)}>
            {AGENTS.map(a => (
              <option key={a.value} value={a.value}>
                {a.label}
              </option>
            ))}
          </select>
          <label htmlFor="model" className="sr-only">
            Model
          </label>
          <input
            id="model"
            className={`${pill} w-36 font-normal text-muted placeholder:text-muted`}
            placeholder="Default model"
            value={model}
            onChange={e => setModel(e.target.value)}
          />
          {agent === "acp" && (
            <>
              <label htmlFor="acp-command" className="sr-only">
                Command that starts the agent
              </label>
              <input
                id="acp-command"
                className={`${pill} w-56 font-mono font-normal`}
                placeholder="gemini --experimental-acp"
                value={acpCommand}
                onChange={e => setAcpCommand(e.target.value)}
              />
            </>
          )}
          <span className="flex-1" />
          <button
            type="submit"
            disabled={!canSend}
            aria-label={busy ? "Starting" : "Start thread"}
            className={`inline-flex size-[34px] items-center justify-center rounded-full transition-colors ${canSend ? "bg-lime text-ink hover:bg-[#b2ec52]" : "bg-cream-deep text-faint"}`}
          >
            <svg aria-hidden="true" viewBox="0 0 16 16" className="size-4">
              <path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>
      </div>

      <div className="mt-2.5 flex flex-wrap items-center gap-1 px-2">
        <label htmlFor="repo" className="sr-only">
          Repository
        </label>
        <input
          id="repo"
          required
          className={`${pill} min-w-0 flex-1 font-normal placeholder:text-muted`}
          placeholder={mode === "cloud" ? "Repository, e.g. https://github.com/you/app.git" : "Folder on your computer, e.g. /Users/you/app"}
          value={repoUrl}
          onChange={e => setRepoUrl(e.target.value)}
        />
        <label htmlFor="base" className="sr-only">
          Start from branch
        </label>
        <input
          id="base"
          required
          className={`${pill} w-28 font-mono font-normal`}
          value={baseBranch}
          onChange={e => setBaseBranch(e.target.value)}
          title="Start from branch"
        />
        <label htmlFor="mode" className="sr-only">
          Where it runs
        </label>
        <select id="mode" className={pill} value={mode} onChange={e => setMode(e.target.value as ThreadMode)}>
          <option value="cloud">Cloud</option>
          <option value="local">This computer</option>
        </select>
        {mode === "cloud" && (
          <>
            <label htmlFor="size" className="sr-only">
              Sandbox size
            </label>
            <select id="size" className={pill} value={size} onChange={e => setSize(e.target.value as SandboxSize)}>
              <option value="small">Small (1 CPU, 2 GB)</option>
              <option value="large">Large (2 CPU, 4 GB)</option>
            </select>
          </>
        )}
      </div>

      {error && (
        <p role="alert" className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          {error}
        </p>
      )}
      {denied && (
        <div className="mt-4">
          <DeniedNotice denied={denied} onDismiss={() => setDenied(null)} />
        </div>
      )}

      <div className="mt-10 flex items-center gap-3 text-[13px] text-muted" aria-hidden="true">
        <span className="h-px flex-1 bg-line" />
        One-click prompts
        <span className="h-px flex-1 bg-line" />
      </div>
      <ul className="mt-4 flex flex-wrap justify-center gap-2.5" aria-label="One-click prompts">
        {STARTERS.map(([label, text]) => (
          <li key={label}>
            <button type="button" onClick={() => setPrompt(text)} className="h-8 rounded-full bg-cream-deep px-4 text-sm hover:bg-cream-hover">
              {label}
            </button>
          </li>
        ))}
      </ul>
    </form>
  );
}
