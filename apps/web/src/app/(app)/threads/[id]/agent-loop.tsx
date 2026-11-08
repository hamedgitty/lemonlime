"use client";

import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { ChevronDown, ClipboardList, ListTodo, MessageCircleQuestionMark, Square, SquareCheck, SquareDot } from "lucide-react";
import {
  AGENT_CAPABILITIES,
  contextPercent,
  PERMISSION_MODES,
  type AgentKind,
  type EventOf,
  type PermissionMode,
  type ReasoningLevel,
  type ThreadOptions,
  type TodoItem,
} from "@lemonlime/protocol";

/**
 * The agent loop around the web composer: model, reasoning and permission controls, the
 * context meter, and the cards above the composer (questions, to-dos), plus the plan card.
 */

const REASONING_LABELS: Record<ReasoningLevel, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
  ultra: "Ultra",
};

const selectClass =
  "h-8 max-w-[11rem] truncate rounded-lg border border-line bg-paper px-2 text-[13px] text-ink hover:border-control focus:border-leaf focus:outline-none disabled:opacity-50";

/** Model and reasoning (one control, two selects) and the permission mode. */
export function OptionsControls({
  kind,
  options,
  working,
  disabled,
  onChange,
}: {
  kind: AgentKind;
  options: ThreadOptions;
  working: boolean;
  disabled: boolean;
  onChange: (change: { model?: string | null; reasoning?: ReasoningLevel | null; permission?: PermissionMode }) => void;
}) {
  const caps = AGENT_CAPABILITIES[kind];
  const models = [...caps.models];
  if (options.model && !models.some(m => m.id === options.model)) models.push({ id: options.model, label: options.model });
  const hint = working ? "Applies from the agent's next turn" : undefined;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {caps.live.model ? (
        <select
          aria-label="Model"
          title={hint}
          className={selectClass}
          disabled={disabled}
          value={options.model ?? ""}
          onChange={e => onChange({ model: e.target.value || null })}
        >
          <option value="">Default model</option>
          {models.map(m => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
      ) : options.model ? (
        <span className="px-1 text-[13px] text-muted">{options.model}</span>
      ) : null}
      {caps.live.reasoning && caps.reasoning.length > 0 && (
        <select
          aria-label="Reasoning"
          title={hint}
          className={selectClass}
          disabled={disabled}
          value={options.reasoning ?? ""}
          onChange={e => onChange({ reasoning: (e.target.value || null) as ReasoningLevel | null })}
        >
          <option value="">Default reasoning</option>
          {caps.reasoning.map(r => (
            <option key={r} value={r}>
              {REASONING_LABELS[r]} reasoning
            </option>
          ))}
        </select>
      )}
      <select
        aria-label="What the agent may do without asking"
        title={hint ?? PERMISSION_MODES[options.permission].hint}
        className={`${selectClass} ${options.permission === "plan" ? "bg-lemon/40" : ""}`}
        disabled={disabled}
        value={options.permission}
        onChange={e => onChange({ permission: e.target.value as PermissionMode })}
      >
        {caps.permissions.map(m => (
          <option key={m} value={m}>
            {PERMISSION_MODES[m].label}
          </option>
        ))}
      </select>
    </div>
  );
}

const number = new Intl.NumberFormat();

/** How full the context window is, with a Compact action for agents that can. */
export function ContextMeter({
  usage,
  canCompact,
  compactDisabled,
  onCompact,
}: {
  usage: { used: number; window: number };
  canCompact: boolean;
  compactDisabled: boolean;
  onCompact: () => void;
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const percent = contextPercent(usage) ?? 0;
  const color = percent >= 90 ? "text-danger" : percent >= 75 ? "text-[#b45309]" : "text-leaf";
  const r = 6.5;
  const c = 2 * Math.PI * r;
  return (
    <div className="relative">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={`Context window: ${percent}% used`}
        onClick={() => setOpen(o => !o)}
        className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2 text-[13px] text-muted tabular-nums hover:bg-cream-deep"
      >
        <svg viewBox="0 0 16 16" aria-hidden className={`size-4 -rotate-90 ${color}`}>
          <circle cx="8" cy="8" r={r} fill="none" stroke="var(--color-line)" strokeWidth="2" />
          <circle
            cx="8"
            cy="8"
            r={r}
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeDasharray={c}
            strokeDashoffset={c * (1 - percent / 100)}
          />
        </svg>
        {percent}%
      </button>
      {open && (
        <div id={panelId} className="absolute right-0 bottom-10 z-10 w-72 rounded-xl border border-line bg-paper p-3 shadow-lg">
          <p className="text-sm font-medium">Context window</p>
          <p className="mt-1 text-[13.5px] text-muted tabular-nums">
            {number.format(usage.used)} of {number.format(usage.window)} tokens used ({percent}%)
          </p>
          <p className="mt-2 text-[13.5px] text-muted">
            {canCompact
              ? "When it fills up, the agent compacts the conversation on its own. Compacting now keeps a summary and frees room."
              : "When it fills up, the agent makes room on its own."}
          </p>
          {canCompact && (
            <button
              type="button"
              className="btn-ghost mt-3 h-8"
              disabled={compactDisabled}
              onClick={() => {
                onCompact();
                setOpen(false);
              }}
            >
              Compact conversation
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function Card({ label, children, tone = "plain" }: { label: string; children: ReactNode; tone?: "plain" | "ask" }) {
  return (
    <section aria-label={label} className={`mb-2 rounded-xl border bg-paper ${tone === "ask" ? "border-[#f0d95c]" : "border-line"}`}>
      {children}
    </section>
  );
}

const TODO_ORDER: Record<TodoItem["status"], number> = { in_progress: 0, pending: 1, completed: 2 };

export function TodoCard({ items }: { items: TodoItem[] }) {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  const done = items.filter(t => t.status === "completed").length;
  const current = items.find(t => t.status === "in_progress");
  const sorted = items.map((t, i) => ({ ...t, i })).sort((a, b) => TODO_ORDER[a.status] - TODO_ORDER[b.status] || a.i - b.i);
  return (
    <Card label="The agent's to-do list">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen(o => !o)}
        className="flex h-10 w-full items-center gap-2.5 px-3 text-left text-[13.5px]"
      >
        <ListTodo aria-hidden className="size-4 shrink-0 text-muted" />
        <span className="shrink-0 font-medium tabular-nums">
          {done} of {items.length} done
        </span>
        <span className="min-w-0 flex-1 truncate text-muted">{current && !open ? current.text : ""}</span>
        <ChevronDown aria-hidden className={`size-4 shrink-0 text-muted ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <ul id={bodyId} className="max-h-56 overflow-y-auto border-t border-line px-3 py-2">
          {sorted.map(t => (
            <li key={t.i} className="flex items-start gap-2.5 py-1 text-[13.5px]">
              {t.status === "completed" ? (
                <SquareCheck aria-label="Done" className="mt-0.5 size-4 shrink-0 text-leaf" />
              ) : t.status === "in_progress" ? (
                <SquareDot aria-label="In progress" className="mt-0.5 size-4 shrink-0" />
              ) : (
                <Square aria-label="Not started" className="mt-0.5 size-4 shrink-0 text-muted" />
              )}
              <span className={`min-w-0 break-words ${t.status === "completed" ? "text-muted line-through" : t.status === "in_progress" ? "font-medium" : ""}`}>
                {t.text}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/** The agent's questions, one step at a time; number keys pick, Enter goes on. */
export function QuestionForm({ request, onAnswer }: { request: EventOf<"question_request">; onAnswer: ((answers: string[][] | null) => void) | undefined }) {
  const questions = request.questions;
  const [step, setStep] = useState(0);
  const [picked, setPicked] = useState<string[][]>(() => questions.map(() => []));
  const [other, setOther] = useState<string[]>(() => questions.map(() => ""));
  const [otherOn, setOtherOn] = useState<boolean[]>(() => questions.map(() => false));
  const [sent, setSent] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const otherRef = useRef<HTMLInputElement>(null);
  const name = useId();
  const q = questions[step]!;
  const multi = q.multiSelect;
  const last = step === questions.length - 1;
  const answerFor = (i: number) => [...picked[i]!, ...(otherOn[i] && other[i]!.trim() ? [other[i]!.trim()] : [])];
  const canGoOn = answerFor(step).length > 0;

  useEffect(() => {
    const a = document.activeElement;
    if ((a instanceof HTMLTextAreaElement || a instanceof HTMLInputElement) && a.value.trim()) return;
    formRef.current?.querySelector<HTMLInputElement>("input[data-option]")?.focus();
  }, [step]);

  const set = <T,>(list: T[], i: number, v: T) => list.map((x, j) => (j === i ? v : x));
  const choose = (index: number) => {
    if (index === q.options.length) {
      const on = multi ? !otherOn[step] : true;
      setOtherOn(o => set(o, step, on));
      if (!multi) setPicked(p => set(p, step, []));
      return;
    }
    const label = q.options[index]!.label;
    if (multi) setPicked(p => set(p, step, p[step]!.includes(label) ? p[step]!.filter(l => l !== label) : [...p[step]!, label]));
    else {
      setPicked(p => set(p, step, [label]));
      setOtherOn(o => set(o, step, false));
    }
  };
  const send = (answers: string[][] | null) => {
    if (sent || !onAnswer) return;
    setSent(true);
    onAnswer(answers);
  };
  const next = (e?: FormEvent) => {
    e?.preventDefault();
    if (!canGoOn) return;
    if (last) send(questions.map((_, i) => answerFor(i)));
    else setStep(s => s + 1);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLFormElement>) => {
    if (e.key === "Enter" && e.target instanceof HTMLInputElement && !e.nativeEvent.isComposing) {
      e.preventDefault();
      next();
      return;
    }
    if (e.target === otherRef.current || e.metaKey || e.ctrlKey || e.altKey) return;
    const n = Number(e.key);
    if (Number.isInteger(n) && n >= 1 && n <= q.options.length + 1) {
      e.preventDefault();
      choose(n - 1);
    }
  };
  const row = (index: number, label: string, description: string | undefined, checked: boolean) => (
    <label
      key={index}
      className={`flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2 text-[13.5px] has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-leaf ${checked ? "border-leaf bg-lime/20" : "border-line hover:bg-cream"}`}
    >
      <input
        data-option
        type={multi ? "checkbox" : "radio"}
        name={name}
        className="mt-0.5 accent-[#3f7a16]"
        checked={checked}
        disabled={sent || !onAnswer}
        onChange={() => choose(index)}
      />
      <span className="min-w-0 flex-1">
        <span className="block font-medium break-words">{label}</span>
        {description && <span className="block text-muted break-words">{description}</span>}
      </span>
      {index < 9 && <kbd className="rounded border border-line px-1.5 text-xs text-muted">{index + 1}</kbd>}
    </label>
  );
  return (
    <Card label="The agent's question" tone="ask">
      <form ref={formRef} onSubmit={next} onKeyDown={onKeyDown} className="px-4 py-3">
        <div className="flex items-center gap-2 text-[13.5px]">
          <MessageCircleQuestionMark aria-hidden className="size-4 shrink-0 text-muted" />
          <span className="font-medium">{questions.length > 1 ? "The agent has some questions" : "The agent has a question"}</span>
          {q.header && <span className="rounded-md bg-cream-deep px-1.5 py-0.5 text-xs text-muted">{q.header}</span>}
          <span className="flex-1" />
          {questions.length > 1 && (
            <span className="text-muted tabular-nums">
              {step + 1} of {questions.length}
            </span>
          )}
        </div>
        <fieldset className="mt-2.5" disabled={sent}>
          <legend className="mb-2 text-[0.9375rem] break-words">{q.question}</legend>
          {multi && <p className="-mt-1 mb-2 text-[13px] text-muted">Pick any that apply.</p>}
          <div className="flex flex-col gap-1.5">
            {q.options.map((o, i) => row(i, o.label, o.description, picked[step]!.includes(o.label)))}
            {row(q.options.length, "Other…", undefined, otherOn[step]!)}
            {otherOn[step] && (
              <input
                ref={otherRef}
                // oxlint-disable-next-line jsx-a11y/no-autofocus -- it appears because the person just chose "Other…" to type
                autoFocus
                className="field h-9"
                aria-label="Your answer"
                placeholder="Type your answer"
                value={other[step]}
                onChange={e => setOther(o => set(o, step, e.target.value))}
              />
            )}
          </div>
        </fieldset>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button type="submit" className="btn-lemon h-8" disabled={!canGoOn || sent || !onAnswer}>
            {last ? "Send answer" : "Next"}
          </button>
          {step > 0 && (
            <button type="button" className="btn-ghost h-8" disabled={sent} onClick={() => setStep(s => s - 1)}>
              Back
            </button>
          )}
          <button type="button" className="btn-ghost h-8" disabled={sent || !onAnswer} onClick={() => send(null)}>
            Skip
          </button>
          <span className="ml-auto text-[13px] text-muted">The agent waits for your answer.</span>
        </div>
      </form>
    </Card>
  );
}

/** A plan from plan mode, with the button that approves it. */
export function PlanCard({ plan, open, onImplement }: { plan: string; open: boolean; onImplement: (() => void) | undefined }) {
  const [sent, setSent] = useState(false);
  return (
    <div role="group" aria-label="The agent's plan" className="rounded-2xl border border-line bg-paper">
      <p className="flex items-center gap-2 border-b border-line px-4 py-2.5 text-[13.5px]">
        <ClipboardList aria-hidden className="size-4 text-muted" />
        <span className="font-medium">Plan</span>
        {open && <span className="text-muted">Waiting for your go-ahead</span>}
      </p>
      <div className="max-h-[480px] overflow-y-auto px-4 py-3 text-sm leading-relaxed break-words whitespace-pre-wrap">{plan}</div>
      {open && (
        <div className="flex flex-wrap items-center gap-2 border-t border-line px-4 py-2.5">
          <button
            type="button"
            className="btn-lemon h-8"
            disabled={sent || !onImplement}
            onClick={() => {
              if (!onImplement) return;
              setSent(true);
              onImplement();
            }}
          >
            Implement plan
          </button>
          <span className="text-[13.5px] text-muted">Or reply to change it.</span>
        </div>
      )}
    </div>
  );
}

const UNANSWERED: Record<string, string> = {
  user: "skipped",
  timeout: "nobody answered in time",
  interrupted: "the turn was stopped",
  expired: "the runner restarted before anyone answered",
};

/** In the timeline: what the agent asked and what came back. */
export function QuestionRecord({ request, result }: { request: EventOf<"question_request">; result: EventOf<"question_result"> | null }) {
  const qs = request.questions;
  if (!result) return <p className="text-[13.5px] text-muted">The agent asked {qs.length > 1 ? `${qs.length} questions` : "a question"}. Answer it below.</p>;
  if (!result.answers)
    return (
      <p className="text-[13.5px] text-muted">
        Not answered ({UNANSWERED[result.by] ?? "skipped"}): {qs.map(q => q.question).join(" ")}
      </p>
    );
  return (
    <div className="text-[13.5px] text-muted">
      {qs.map((q, i) => (
        <p key={i} className="break-words">
          {q.question} <span className="font-medium text-ink">{(result.answers?.[i] ?? []).join(", ") || "No answer"}</span>
        </p>
      ))}
    </div>
  );
}
