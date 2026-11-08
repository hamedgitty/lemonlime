import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import {
  Check,
  ChevronDown,
  ClipboardList,
  FilePen,
  Hammer,
  Hand,
  ListTodo,
  MessageCircleQuestionMark,
  Shrink,
  Square,
  SquareCheck,
  SquareDot,
  Zap,
} from "lucide-react";
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
import { Markdown } from "../lib/markdown.tsx";
import { effortLevels } from "../lib/models.ts";
import { keysFor } from "../lib/shortcuts.ts";
import { loadUiPrefs } from "../lib/storage.ts";
import { PickerButton } from "./Composer.tsx";
import { ModelControl } from "./ModelControl.tsx";
import { Kbd, Menu, MenuChoice, MenuLabel, MenuSeparator, Popover, Tip } from "./primitives.tsx";
import { Button, Spinner, cx, inputClass } from "./ui.tsx";

/**
 * The agent loop around the composer: model, reasoning and permission pickers, the
 * context meter, and the cards that sit above the composer (questions, to-dos) plus the
 * plan card in the timeline.
 */

export const REASONING_LABELS: Record<ReasoningLevel, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
  ultra: "Ultra",
};

const PERMISSION_ICONS: Record<PermissionMode, ReactNode> = {
  ask: <Hand />,
  edits: <FilePen />,
  full: <Zap />,
  plan: <ClipboardList />,
};

/** What a change does while the agent is working. */
const NEXT_TURN = "Applies from the agent's next turn";

/**
 * The model and effort inside a thread: the composer's model control with only the thread's
 * agent. Changes go to the runner and apply from the agent's next turn.
 */
export function ModelPicker({
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
  onChange: (change: { model?: string | null; reasoning?: ReasoningLevel | null; fast?: boolean }) => void;
}) {
  const caps = AGENT_CAPABILITIES[kind];
  const prefs = useMemo(() => loadUiPrefs(), []);
  const offered = effortLevels(kind, prefs.showMaxReasoning);
  // A level picked before (or by the thread's start) stays on offer.
  const levels = caps.live.reasoning ? (options.reasoning && !offered.includes(options.reasoning) ? [...offered, options.reasoning] : offered) : [];
  return (
    <ModelControl
      agent={kind}
      tabs={[kind]}
      model={options.model}
      reasoning={options.reasoning}
      fast={Boolean(options.fast)}
      levels={levels}
      fixedModel={!caps.live.model}
      onModel={(_, model) => onChange({ model })}
      onReasoning={caps.live.reasoning ? reasoning => onChange({ reasoning }) : undefined}
      onFast={caps.fast ? fast => onChange({ fast }) : undefined}
      cycleKeys={keysFor("cycle-effort", prefs.shortcuts)}
      disabled={disabled}
      note={working ? NEXT_TURN : undefined}
    />
  );
}

/** What the agent may do without asking, including plan mode. */
export function PermissionPicker({
  kind,
  value,
  working,
  disabled,
  onChange,
  side = "top",
}: {
  kind: AgentKind;
  value: PermissionMode;
  working: boolean;
  disabled: boolean;
  onChange: (mode: PermissionMode) => void;
  /** Where the menu opens (above the thread's composer; below it on Home). */
  side?: "top" | "bottom";
}) {
  const modes = AGENT_CAPABILITIES[kind].permissions;
  return (
    <Menu
      side={side}
      trigger={
        <PickerButton
          icon={PERMISSION_ICONS[value]}
          tone="muted"
          disabled={disabled}
          aria-label={`Permissions: ${PERMISSION_MODES[value].label}`}
          className={cx(value === "plan" && "bg-lemon-soft text-ink hover:bg-lemon-soft")}
        >
          {/* A narrow composer (a split pane) keeps the icon; the name is in the label and tooltip. */}
          <span className="@max-[420px]/tools:sr-only" title={PERMISSION_MODES[value].label}>
            {PERMISSION_MODES[value].label}
          </span>
        </PickerButton>
      }
    >
      <MenuLabel>What the agent may do without asking</MenuLabel>
      <MenuChoice
        value={value}
        onChange={onChange}
        options={modes.map(m => ({ value: m, icon: PERMISSION_ICONS[m], label: <span title={PERMISSION_MODES[m].hint}>{PERMISSION_MODES[m].label}</span> }))}
      />
      <MenuSeparator />
      <MenuLabel>{working ? NEXT_TURN : PERMISSION_MODES[value].hint}</MenuLabel>
    </Menu>
  );
}

const number = new Intl.NumberFormat();

/** A small ring showing how full the context window is; its popover offers to compact. */
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
  const percent = contextPercent(usage) ?? 0;
  const tone = percent >= 90 ? "text-danger" : percent >= 75 ? "text-amber" : "text-leaf";
  const r = 6.5;
  const circumference = 2 * Math.PI * r;
  const [open, setOpen] = useState(false);
  return (
    <Popover
      side="top"
      align="end"
      open={open}
      onOpenChange={setOpen}
      className="w-[280px] p-3"
      trigger={
        <button
          type="button"
          aria-label={`Context window: ${percent}% used`}
          className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-2 text-[13px] font-medium text-ink-soft tabular-nums hover:bg-cream-deep data-[popup-open]:bg-cream-deep"
        >
          <svg viewBox="0 0 16 16" aria-hidden="true" className={cx("size-4 -rotate-90", tone)}>
            <circle cx="8" cy="8" r={r} fill="none" stroke="var(--color-line-strong)" strokeWidth="2" />
            <circle
              cx="8"
              cy="8"
              r={r}
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeDasharray={circumference}
              strokeDashoffset={circumference * (1 - percent / 100)}
            />
          </svg>
          {percent}%
        </button>
      }
    >
      <p className="text-[14px] font-medium text-ink">Context window</p>
      <p className="mt-1 text-[13.5px] text-ink-soft tabular-nums">
        {number.format(usage.used)} of {number.format(usage.window)} tokens used ({percent}%)
      </p>
      <p className="mt-2 text-[13.5px] text-ink-soft">
        {canCompact
          ? "When it fills up, the agent compacts the conversation on its own. Compacting now keeps a summary and frees room."
          : "When it fills up, the agent makes room on its own."}
      </p>
      {canCompact && (
        <Button
          size="sm"
          variant="secondary"
          className="mt-3"
          disabled={compactDisabled}
          onClick={() => {
            onCompact();
            setOpen(false);
          }}
        >
          <Shrink aria-hidden="true" className="size-3.5" />
          Compact conversation
        </Button>
      )}
    </Popover>
  );
}

/** The one look every card above the composer shares. */
function ComposerCard({ children, label, className }: { children: ReactNode; label: string; className?: string }) {
  return (
    <section aria-label={label} className={cx("mb-2 rounded-xl border border-line bg-paper shadow-panel", className)}>
      {children}
    </section>
  );
}

const TODO_ORDER: Record<TodoItem["status"], number> = { in_progress: 0, pending: 1, completed: 2 };

/** The agent's to-do list: "3 of 7 done", opening to the whole list. */
export function TodoCard({ items }: { items: TodoItem[] }) {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  const done = items.filter(t => t.status === "completed").length;
  const current = items.find(t => t.status === "in_progress");
  const sorted = [...items].map((t, i) => ({ ...t, i })).sort((a, b) => TODO_ORDER[a.status] - TODO_ORDER[b.status] || a.i - b.i);
  return (
    <ComposerCard label="The agent's to-do list">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen(o => !o)}
        className="flex h-10 w-full items-center gap-2.5 rounded-xl px-3 text-left text-[13.5px] hover:bg-cream/60 focus-visible:-outline-offset-2"
      >
        <ListTodo aria-hidden="true" className="size-4 shrink-0 text-ink-soft" />
        <span className="shrink-0 font-medium text-ink tabular-nums">
          {done} of {items.length} done
        </span>
        <span className="min-w-0 flex-1 truncate text-ink-faint">{current && !open ? current.text : ""}</span>
        <ChevronDown aria-hidden="true" className={cx("size-4 shrink-0 text-ink-faint", open && "rotate-180")} />
      </button>
      {open && (
        <ul id={bodyId} className="scroll-thin max-h-[220px] overflow-y-auto border-t border-line px-3 py-2">
          {sorted.map(t => (
            <li key={t.i} className="flex items-start gap-2.5 py-1 text-[13.5px]">
              {t.status === "completed" ? (
                <SquareCheck aria-label="Done" className="mt-0.5 size-4 shrink-0 text-leaf" />
              ) : t.status === "in_progress" ? (
                <SquareDot aria-label="In progress" className="mt-0.5 size-4 shrink-0 text-ink" />
              ) : (
                <Square aria-label="Not started" className="mt-0.5 size-4 shrink-0 text-ink-faint" />
              )}
              <span
                className={cx(
                  "min-w-0 [overflow-wrap:anywhere]",
                  t.status === "completed"
                    ? "text-ink-faint line-through decoration-ink-faint/50"
                    : t.status === "in_progress"
                      ? "font-medium text-ink"
                      : "text-ink-soft",
                )}
              >
                {t.text}
              </span>
            </li>
          ))}
        </ul>
      )}
    </ComposerCard>
  );
}

/**
 * The agent's questions, one step at a time: options as radio buttons (or checkboxes when
 * several can be picked), plus "Other…" to type an answer. Number keys pick an option and
 * Enter goes on; nothing animates on either.
 */
export function QuestionCard({ request, onAnswer }: { request: EventOf<"question_request">; onAnswer: ((answers: string[][] | null) => void) | undefined }) {
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

  const firstInput = () => formRef.current?.querySelector<HTMLInputElement>("input[data-option]");
  // Ready for the keyboard, unless the person is in the middle of writing something.
  useEffect(() => {
    const a = document.activeElement;
    if ((a instanceof HTMLTextAreaElement || a instanceof HTMLInputElement) && a.value.trim()) return;
    firstInput()?.focus();
  }, [step]);

  const set = <T,>(list: T[], i: number, v: T) => list.map((x, j) => (j === i ? v : x));
  const choose = (index: number) => {
    if (index === q.options.length) {
      const on = multi ? !otherOn[step] : true;
      setOtherOn(o => set(o, step, on));
      if (!multi) setPicked(p => set(p, step, []));
      if (on) otherRef.current?.focus();
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
    // Enter goes on from an option or the typed answer (not every webview submits a form from a radio button).
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

  const optionRow = (index: number, label: ReactNode, description: string | undefined, checked: boolean) => (
    <label
      key={index}
      className={cx(
        "flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2 text-[13.5px]",
        "has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-1 has-[:focus-visible]:outline-leaf",
        checked ? "border-leaf bg-lime-soft/60" : "border-line hover:bg-cream/60",
      )}
    >
      <input
        data-option
        type={multi ? "checkbox" : "radio"}
        name={name}
        className="sr-only"
        checked={checked}
        disabled={sent || !onAnswer}
        onChange={() => choose(index)}
      />
      <span
        aria-hidden="true"
        className={cx(
          "mt-0.5 flex size-4 shrink-0 items-center justify-center border",
          multi ? "rounded-[4px]" : "rounded-full",
          checked ? "border-leaf bg-leaf" : "border-control bg-paper",
        )}
      >
        {checked && (multi ? <Check className="size-3 text-paper" strokeWidth={3.5} /> : <span className="size-1.5 rounded-full bg-paper" />)}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block font-medium text-ink [overflow-wrap:anywhere]">{label}</span>
        {description && <span className="mt-0.5 block text-ink-soft [overflow-wrap:anywhere]">{description}</span>}
      </span>
      {index < 9 && <Kbd>{index + 1}</Kbd>}
    </label>
  );

  return (
    <ComposerCard label="The agent's question" className="border-[#f0d95c]">
      <form ref={formRef} onSubmit={next} onKeyDown={onKeyDown} className="px-4 pt-3 pb-3">
        <div className="flex items-center gap-2 text-[13.5px]">
          <MessageCircleQuestionMark aria-hidden="true" className="size-4 shrink-0 text-ink-soft" />
          <span className="font-medium text-ink">{questions.length > 1 ? "The agent has some questions" : "The agent has a question"}</span>
          {q.header && <span className="rounded-md bg-cream-deep px-1.5 py-0.5 text-[12.5px] text-ink-soft">{q.header}</span>}
          <span className="flex-1" />
          {questions.length > 1 && (
            <span className="text-ink-faint tabular-nums">
              {step + 1} of {questions.length}
            </span>
          )}
        </div>
        <fieldset className="mt-2.5" disabled={sent}>
          <legend className="mb-2 text-[14.5px] text-ink [overflow-wrap:anywhere]">{q.question}</legend>
          {multi && <p className="-mt-1 mb-2 text-[13px] text-ink-faint">Pick any that apply.</p>}
          <div role={multi ? "group" : "radiogroup"} aria-label={q.question} className="flex flex-col gap-1.5">
            {q.options.map((o, i) => optionRow(i, o.label, o.description, picked[step]!.includes(o.label)))}
            {optionRow(q.options.length, "Other…", undefined, otherOn[step]!)}
            {otherOn[step] && (
              <input
                ref={otherRef}
                // oxlint-disable-next-line jsx-a11y/no-autofocus -- it appears because the person just chose "Other…" to type
                autoFocus
                value={other[step]}
                onChange={e => setOther(o => set(o, step, e.target.value))}
                placeholder="Type your answer"
                aria-label="Your answer"
                className={cx(inputClass, "h-9 py-1.5 text-[13.5px]")}
              />
            )}
          </div>
        </fieldset>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button type="submit" variant="primary" size="sm" disabled={!canGoOn || sent || !onAnswer}>
            {sent && <Spinner />}
            {last ? "Send answer" : "Next"}
          </Button>
          {step > 0 && (
            <Button variant="secondary" size="sm" disabled={sent} onClick={() => setStep(s => s - 1)}>
              Back
            </Button>
          )}
          <Button variant="ghost" size="sm" disabled={sent || !onAnswer} onClick={() => send(null)}>
            Skip
          </Button>
          <span className="ml-auto text-[13px] text-ink-faint">The agent waits for your answer.</span>
        </div>
      </form>
    </ComposerCard>
  );
}

/** A plan from plan mode, with the button that approves it. */
export function PlanCard({ plan, open, onImplement }: { plan: string; open: boolean; onImplement: (() => void) | undefined }) {
  const [sent, setSent] = useState(false);
  return (
    <div className="rounded-2xl border border-line bg-paper" role="group" aria-label="The agent's plan">
      <div className="flex items-center gap-2 border-b border-line px-4 py-2.5 text-[13.5px]">
        <ClipboardList aria-hidden="true" className="size-4 shrink-0 text-ink-soft" />
        <span className="font-medium text-ink">Plan</span>
        {open && <span className="text-ink-faint">Waiting for your go-ahead</span>}
      </div>
      <div className="scroll-thin max-h-[480px] overflow-y-auto px-4 py-3 text-[14px] leading-relaxed text-ink">
        <Markdown text={plan} />
      </div>
      {open && (
        <div className="flex flex-wrap items-center gap-2 border-t border-line px-4 py-2.5">
          <Tip label="Leaves plan mode and tells the agent to start">
            <Button
              variant="primary"
              size="sm"
              disabled={sent || !onImplement}
              onClick={() => {
                if (!onImplement) return;
                setSent(true);
                onImplement();
              }}
            >
              {sent ? <Spinner /> : <Hammer aria-hidden="true" className="size-3.5" />}
              Implement plan
            </Button>
          </Tip>
          <span className="text-[13.5px] text-ink-soft">Or reply to change it.</span>
        </div>
      )}
    </div>
  );
}

const UNANSWERED_BECAUSE: Record<string, string> = {
  user: "skipped",
  timeout: "nobody answered in time",
  interrupted: "the turn was stopped",
  expired: "the runner restarted before anyone answered",
};

/** In the timeline: what the agent asked and what the user answered. */
export function QuestionRecord({
  questions,
  answers,
  state,
  by,
}: {
  questions: { question: string }[];
  answers: string[][] | null;
  state: "waiting" | "answered" | "declined";
  by?: string | undefined;
}) {
  return (
    <div className="flex items-start gap-2.5 px-1 text-[13.5px] text-ink-soft" role="note">
      <MessageCircleQuestionMark aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-ink-faint" />
      <div className="min-w-0 [overflow-wrap:anywhere]">
        {state === "waiting" ? (
          <p>The agent asked {questions.length > 1 ? `${questions.length} questions` : "a question"}. Answer it below the conversation.</p>
        ) : state === "declined" ? (
          <p>
            Not answered ({UNANSWERED_BECAUSE[by ?? "user"] ?? "skipped"}): {questions.map(q => q.question).join(" ")}
          </p>
        ) : (
          questions.map((q, i) => (
            <p key={i}>
              {q.question} <span className="font-medium text-ink">{(answers?.[i] ?? []).join(", ") || "No answer"}</span>
            </p>
          ))
        )}
      </div>
    </div>
  );
}

/** In the timeline: the thread's options changed. */
export function OptionsRow({ options }: { options: ThreadOptions }) {
  const parts = [
    PERMISSION_MODES[options.permission].label,
    options.model
      ? (Object.values(AGENT_CAPABILITIES)
          .flatMap(c => c.models)
          .find(m => m.id === options.model)?.label ?? options.model)
      : "default model",
    options.reasoning ? `${REASONING_LABELS[options.reasoning].toLowerCase()} effort` : null,
    options.fast ? "fast mode" : null,
  ];
  return (
    <div className="flex items-center gap-3 py-0.5 text-xs text-ink-faint" role="note">
      <span className="h-px flex-1 bg-line" />
      <span>Now using {parts.filter(Boolean).join(", ")}</span>
      <span className="h-px flex-1 bg-line" />
    </div>
  );
}
