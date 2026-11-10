import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from "react";
import { Check, ChevronRight, Gauge, Plus, RefreshCw, Search, Zap } from "lucide-react";
import { AGENT_CAPABILITIES, type AgentKind, type AgentModel, type ReasoningLevel } from "@lemonlime/protocol";
import { AGENT_LABELS } from "../lib/format.ts";
import { composing } from "../lib/ime.ts";
import { cycleEffort, filterModels, modelLabel, parseOpencodeModels, splitModels } from "../lib/models.ts";
import { openAgentsSettings } from "../lib/settingsNav.ts";
import { keyCaps } from "../lib/shortcuts.ts";
import { opencodeModelsText } from "../lib/system.ts";
import { AgentIcon } from "./AgentIcon.tsx";
import { Kbd, Menu, MenuBadge, MenuChoice, MenuItem, MenuSeparator, Popover, Tip, Toggle } from "./primitives.tsx";
import { Spinner, cx } from "./ui.tsx";

/**
 * The composer's model control: quiet text under the message box, the model's name and the
 * effort level beside it ("Opus 5.5 Medium"), opening the model picker. The picker has a tab
 * per agent, a search box, the models, older ones under "More models", an Effort row with
 * its own submenu, and fast mode where the agent has one. On Home picking another agent's
 * model switches the agent; in a thread only the thread's agent is shown.
 */

export const EFFORT_LABELS: Record<ReasoningLevel, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
  ultra: "Ultra",
};

// ── Model lists ──────────────────────────────────────────────

export type ModelList = { state: "ready"; models: AgentModel[] } | { state: "loading" } | { state: "error"; message: string };

const OPENCODE_CACHE = "lemonlime:opencode-models";
let opencode: ModelList = (() => {
  try {
    const cached = JSON.parse(localStorage.getItem(OPENCODE_CACHE) ?? "null") as AgentModel[] | null;
    return Array.isArray(cached) && cached.length ? { state: "ready", models: cached } : { state: "loading" };
  } catch {
    return { state: "loading" };
  }
})();
let opencodeAsked = false;
const listeners = new Set<() => void>();

/** Ask OpenCode for its models (once per launch, or again on retry); the last list is kept for next time. */
function loadOpencode(force = false): void {
  if (opencodeAsked && !force) return;
  opencodeAsked = true;
  if (opencode.state !== "ready") setOpencode({ state: "loading" });
  void opencodeModelsText().then(
    text => {
      const models = parseOpencodeModels(text);
      if (!models.length) return setOpencode({ state: "error", message: "OpenCode didn't list any models." });
      try {
        localStorage.setItem(OPENCODE_CACHE, JSON.stringify(models));
      } catch {
        /* ignore */
      }
      setOpencode({ state: "ready", models });
    },
    (err: unknown) => {
      // Keep a list it gave before; it's better than nothing.
      if (opencode.state !== "ready") setOpencode({ state: "error", message: err instanceof Error ? err.message : String(err) });
    },
  );
}
function setOpencode(next: ModelList): void {
  opencode = next;
  for (const l of listeners) l();
}

/** Each agent's models: the built-in lists, and OpenCode's from its own CLI. */
export function useAgentModels(): { list: (kind: AgentKind) => ModelList; retry: (kind: AgentKind) => void } {
  const oc = useSyncExternalStore(
    useCallback((l: () => void) => {
      listeners.add(l);
      return () => listeners.delete(l);
    }, []),
    () => opencode,
  );
  const list = useCallback(
    (kind: AgentKind): ModelList => {
      if (kind === "opencode") return oc;
      return { state: "ready", models: AGENT_CAPABILITIES[kind].models };
    },
    [oc],
  );
  return { list, retry: kind => kind === "opencode" && loadOpencode(true) };
}

/** Load an agent's model list if it comes from its CLI (call from an effect, never while rendering). */
function useLoadModels(kind: AgentKind): void {
  useEffect(() => {
    if (kind === "opencode") loadOpencode();
  }, [kind]);
}

/** The model a new thread starts with when none was picked: the agent's first listed one. */
export function defaultModel(kind: AgentKind): string | null {
  return kind === "claude-code" || kind === "codex" ? (AGENT_CAPABILITIES[kind].models[0]?.id ?? null) : null;
}

// ── The control ──────────────────────────────────────────────

export interface ModelControlProps {
  /** The agent in use. */
  agent: AgentKind;
  /** Agent tabs, in order (only the thread's agent inside a thread). */
  tabs: readonly AgentKind[];
  model: string | null;
  reasoning: ReasoningLevel | null;
  fast: boolean;
  /** Effort levels to offer for the agent in use. */
  levels: readonly ReasoningLevel[];
  /** ACP: the saved agents, as the "models" of the ACP tab, and the one picked. */
  acpAgents?: readonly { id: string; name: string }[];
  acpId?: string | null;
  onModel: (agent: AgentKind, model: string | null) => void;
  /** null: let the agent use its own default effort. */
  onReasoning?: ((r: ReasoningLevel | null) => void) | undefined;
  onFast?: ((on: boolean) => void) | undefined;
  /** "+": add another agent (Settings → Agents → Harness unless given). */
  onConnect?: () => void;
  /** Keys for the cycle shortcut, e.g. "alt+t" ("" when turned off). */
  cycleKeys: string;
  disabled?: boolean;
  /** Changes apply from the next turn (shown while the agent works). */
  note?: string | undefined;
  /** What to show when the agent can't change its model here. */
  fixedModel?: boolean;
  /** Where the menus open: below on Home, above in a thread (the composer is at the bottom). */
  side?: "top" | "bottom";
  /** How the picker lines up with the trigger (it sits at the right end of the row under the composer). */
  align?: "start" | "end";
}

export function ModelControl(p: ModelControlProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);
  const models = useAgentModels();
  useLoadModels(p.agent);
  const current = p.agent === "acp" ? null : models.list(p.agent);
  const acpName = p.agent === "acp" ? (p.acpAgents?.find(a => a.id === p.acpId)?.name ?? "ACP agent") : null;
  const label =
    acpName ?? (current?.state === "ready" ? modelLabel(current.models, p.model) : p.model) ?? (p.agent === "opencode" ? "OpenCode" : AGENT_LABELS[p.agent]);
  const levels = p.levels;
  const effort = levels.length > 0 && p.onReasoning;

  // ⌥T (or the user's own keys) in this composer: the next effort level.
  const latest = useRef({ levels, reasoning: p.reasoning, onReasoning: p.onReasoning, disabled: p.disabled });
  latest.current = { levels, reasoning: p.reasoning, onReasoning: p.onReasoning, disabled: p.disabled };
  useEffect(() => {
    const box = rootRef.current?.closest("[data-composer]");
    if (!box) return;
    const on = (e: Event) => {
      const l = latest.current;
      if ((e as CustomEvent<string>).detail !== "cycle-effort" || l.disabled || !l.onReasoning) return;
      const next = cycleEffort(l.levels, l.reasoning);
      if (next) l.onReasoning(next);
    };
    box.addEventListener("lemonlime:composer-shortcut", on);
    return () => box.removeEventListener("lemonlime:composer-shortcut", on);
  }, []);

  const effortLabel = effort && p.reasoning ? EFFORT_LABELS[p.reasoning] : null;
  return (
    <span ref={rootRef} className="inline-flex min-w-0 items-center">
      <Popover
        open={open}
        onOpenChange={setOpen}
        side={p.side ?? "top"}
        align={p.align ?? "end"}
        className="w-[340px] max-w-[calc(100vw-24px)]"
        trigger={
          <button
            type="button"
            disabled={p.disabled}
            aria-label={`Model: ${label}${p.agent !== "acp" ? `, ${AGENT_LABELS[p.agent]}` : ""}${effortLabel ? `, ${effortLabel} effort` : ""}`}
            className="inline-flex h-8 max-w-[240px] min-w-0 items-center gap-1.5 rounded-lg px-2 text-[14px] transition-colors duration-100 hover:bg-cream-deep disabled:opacity-50 data-[popup-open]:bg-cream-deep"
          >
            {/* The model's name keeps its room; the effort beside it gives way first. */}
            <span className="min-w-0 truncate font-medium text-ink">{label}</span>
            {effortLabel && <span className="shrink-0 text-ink-soft @max-[420px]/tools:hidden">{effortLabel}</span>}
            <Chevron />
          </button>
        }
      >
        {open && <Picker {...p} onClose={() => setOpen(false)} />}
      </Popover>
    </span>
  );
}

function Chevron() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" className="size-3.5 shrink-0 text-ink-faint">
      <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Levels slow and heavy enough to say so beside them. */
const COSTLY: readonly ReasoningLevel[] = ["max", "ultra"];

/** The picker's Effort row: the level now on the right, and a submenu of the levels. */
function EffortRow(p: ModelControlProps) {
  const caps = keyCaps(p.cycleKeys);
  const current = p.reasoning ? EFFORT_LABELS[p.reasoning] : "Default";
  const highest = p.levels[p.levels.length - 1];
  return (
    <Menu
      side="right"
      align="start"
      className="w-[280px] max-w-[calc(100vw-24px)]"
      trigger={
        <button
          type="button"
          disabled={p.disabled}
          className="flex h-9 w-full items-center gap-2.5 rounded-[7px] px-2.5 text-left text-[14px] text-ink hover:bg-cream-deep disabled:opacity-50 data-[popup-open]:bg-cream-deep"
        >
          <Gauge aria-hidden="true" className="size-4 shrink-0 text-ink-faint" />
          <span className="flex-1">Effort</span>
          <span className="text-ink-soft">{current}</span>
          <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-ink-faint" />
        </button>
      }
    >
      <p className="px-2.5 pt-1.5 pb-2 text-[13px] leading-snug text-pretty text-ink-soft">
        Higher effort means more thorough answers but takes longer and uses your plan's limits faster.
      </p>
      <MenuChoice
        value={p.reasoning ?? ""}
        onChange={v => p.onReasoning?.(v ? (v as ReasoningLevel) : null)}
        closeOnClick
        options={[
          { value: "", label: "Default", badge: <MenuBadge>Recommended</MenuBadge> },
          ...p.levels.map(r => ({
            value: r,
            label: EFFORT_LABELS[r],
            ...(r === highest && COSTLY.includes(r) ? { badge: <MenuBadge tone="caution">Uses more</MenuBadge> } : {}),
          })),
        ]}
      />
      <MenuSeparator />
      <MenuItem
        onSelect={() => {
          const next = cycleEffort(p.levels, p.reasoning);
          if (next) p.onReasoning?.(next);
        }}
        hint={
          caps.length ? (
            <span className="inline-flex gap-0.5" aria-label={`Shortcut ${caps.join(" ")}`}>
              {caps.map(k => (
                <Kbd key={k}>{k}</Kbd>
              ))}
            </span>
          ) : undefined
        }
      >
        Next level
      </MenuItem>
    </Menu>
  );
}

// ── The picker ───────────────────────────────────────────────

function Picker(p: ModelControlProps & { onClose: () => void }) {
  const [viewing, setViewing] = useState<AgentKind>(p.tabs.includes(p.agent) ? p.agent : (p.tabs[0] ?? p.agent));
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const search = useRef<HTMLInputElement>(null);
  const tabRefs = useRef(new Map<AgentKind, HTMLButtonElement>());
  const models = useAgentModels();
  useLoadModels(viewing);
  const id = useId();
  const panelId = `${id}-panel`;
  const listId = `${id}-list`;

  // Set by the arrow keys on the tabs, so focus stays on the tab the person just moved to.
  const keepTabFocus = useRef(false);
  useEffect(() => {
    if (keepTabFocus.current) {
      keepTabFocus.current = false;
      return;
    }
    // Ready to type a search as soon as it opens.
    const t = setTimeout(() => search.current?.focus(), 0);
    return () => clearTimeout(t);
  }, [viewing]);

  const list: ModelList = viewing === "acp" ? { state: "ready", models: (p.acpAgents ?? []).map(a => ({ id: a.id, label: a.name })) } : models.list(viewing);
  const all = list.state === "ready" ? list.models : [];
  const { main, older } = splitModels(all);
  const typed = query.trim();
  const found = typed ? filterModels(all, typed) : main;
  // A model the list doesn't know can still be typed in (agents take any name they accept).
  const custom = typed && viewing !== "acp" && !/\s/.test(typed) && !all.some(m => m.id === typed);
  const shown: AgentModel[] = custom ? [...found, { id: typed, label: `Use “${typed}”` }] : found;
  const chosen = viewing === p.agent ? (viewing === "acp" ? (p.acpId ?? null) : p.model) : null;
  const fixed = p.fixedModel && viewing === p.agent;

  const pick = (m: string | null) => {
    p.onModel(viewing, m);
    p.onClose();
  };

  const optionId = (i: number) => `${listId}-${i}`;
  const activeIndex = Math.min(active, Math.max(0, shown.length - 1));

  const onTabKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const n = p.tabs.length;
    const to = e.key === "ArrowRight" ? (i + 1) % n : e.key === "ArrowLeft" ? (i - 1 + n) % n : e.key === "Home" ? 0 : e.key === "End" ? n - 1 : -1;
    if (to < 0) return;
    e.preventDefault();
    const kind = p.tabs[to]!;
    keepTabFocus.current = kind !== viewing;
    setViewing(kind);
    setQuery("");
    setActive(0);
    tabRefs.current.get(kind)?.focus();
  };

  const onSearchKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!shown.length) return;
      const to = e.key === "ArrowDown" ? (activeIndex + 1) % shown.length : (activeIndex - 1 + shown.length) % shown.length;
      setActive(to);
      // Keep the highlighted model in view in a long list (the pointer moving over rows never scrolls it).
      document.getElementById(optionId(to))?.scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter" && !composing(e)) {
      e.preventDefault();
      const m = shown[activeIndex];
      if (m) pick(m.id);
    }
  };

  const caps = AGENT_CAPABILITIES[viewing];

  return (
    <div className="flex flex-col">
      <div className="flex items-end gap-0.5 border-b border-line px-1.5 pt-1.5">
        <div role="tablist" aria-label="Agents" className="flex items-end gap-0.5">
          {p.tabs.map((kind, i) => (
            <Tip key={kind} label={AGENT_LABELS[kind]} side="top">
              <button
                ref={el => void (el ? tabRefs.current.set(kind, el) : tabRefs.current.delete(kind))}
                type="button"
                role="tab"
                aria-selected={viewing === kind}
                aria-controls={panelId}
                aria-label={AGENT_LABELS[kind]}
                tabIndex={viewing === kind ? 0 : -1}
                onClick={() => {
                  setViewing(kind);
                  setQuery("");
                  setActive(0);
                }}
                onKeyDown={e => onTabKey(e, i)}
                className={cx(
                  "relative inline-flex h-9 w-9 items-center justify-center rounded-t-md text-ink-soft transition-colors duration-100 hover:text-ink focus-visible:-outline-offset-2",
                  viewing === kind && "text-ink",
                )}
              >
                <AgentIcon kind={kind} className="size-[18px]" />
                <span aria-hidden="true" className={cx("absolute inset-x-2 -bottom-px h-0.5 rounded-full", viewing === kind ? "bg-ink" : "bg-transparent")} />
              </button>
            </Tip>
          ))}
        </div>
        <Tip label="Connect another agent" side="top">
          <button
            type="button"
            aria-label="Connect another agent"
            onClick={() => {
              p.onClose();
              (p.onConnect ?? (() => openAgentsSettings({ tab: "harness" })))();
            }}
            className="mb-1 ml-1 inline-flex size-7 shrink-0 items-center justify-center rounded-md bg-cream-deep text-ink-soft transition-colors duration-100 hover:bg-cream-hover hover:text-ink"
          >
            <Plus aria-hidden="true" className="size-4" />
          </button>
        </Tip>
      </div>

      <div id={panelId} role="tabpanel" aria-label={AGENT_LABELS[viewing]} className="flex flex-col">
        {list.state === "loading" ? (
          <div className="flex items-center justify-center gap-2 px-3 py-10 text-[14px] text-ink-soft" role="status">
            <Spinner /> Loading {AGENT_LABELS[viewing]}'s models…
          </div>
        ) : list.state === "error" ? (
          <div className="flex flex-col items-center gap-3 px-4 py-8 text-center" role="alert">
            <AgentIcon kind={viewing} className="size-8 text-ink-faint" />
            <p className="text-[14px] text-ink-soft" title={list.message}>
              Couldn't load models for {AGENT_LABELS[viewing]}.
            </p>
            <Tip label="Try again">
              <button
                type="button"
                aria-label={`Load ${AGENT_LABELS[viewing]}'s models again`}
                onClick={() => models.retry(viewing)}
                className="inline-flex size-8 items-center justify-center rounded-lg border border-line-strong text-ink-soft hover:bg-cream-deep hover:text-ink"
              >
                <RefreshCw aria-hidden="true" className="size-4" />
              </button>
            </Tip>
          </div>
        ) : fixed ? (
          <p className="px-3 py-6 text-center text-[14px] text-ink-soft">This agent picks its model when the thread starts; it can't change here.</p>
        ) : all.length === 0 ? (
          <EmptyList agent={viewing} onClose={p.onClose} />
        ) : (
          <>
            <div className="p-2 pb-1">
              <label className="relative block">
                <span className="sr-only">Search models</span>
                <Search aria-hidden="true" className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-ink-faint" />
                <input
                  ref={search}
                  type="text"
                  role="combobox"
                  aria-expanded="true"
                  aria-controls={listId}
                  aria-autocomplete="list"
                  aria-activedescendant={shown.length ? optionId(activeIndex) : undefined}
                  value={query}
                  onChange={e => {
                    setQuery(e.target.value);
                    setActive(0);
                  }}
                  onKeyDown={onSearchKey}
                  placeholder={viewing === "acp" ? "Search agents" : "Search models"}
                  spellCheck={false}
                  autoComplete="off"
                  className="h-8 w-full rounded-lg border border-line-strong bg-paper pr-2.5 pl-8 text-[14px] text-ink placeholder:text-ink-faint focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-leaf"
                />
              </label>
            </div>
            <div
              id={listId}
              role="listbox"
              aria-label={viewing === "acp" ? "ACP agents" : "Models"}
              className="scroll-thin max-h-[300px] overflow-y-auto px-1 pb-1"
            >
              {found.length === 0 && <p className="px-2.5 py-2 text-[14px] text-ink-soft">No model matches “{typed}”.</p>}
              {shown.map((m, i) => (
                <ModelRow
                  key={m.id}
                  id={optionId(i)}
                  model={m}
                  selected={m.id === chosen}
                  active={i === activeIndex}
                  onPick={() => pick(m.id)}
                  onHover={() => setActive(i)}
                />
              ))}
            </div>
            {!typed && older.length > 0 && (
              <div className="border-t border-line p-1">
                <OlderModels models={older} chosen={chosen} onPick={pick} />
              </div>
            )}
          </>
        )}
        {viewing === p.agent && p.levels.length > 0 && p.onReasoning && (
          <div className="border-t border-line p-1">
            <EffortRow {...p} />
          </div>
        )}
        {caps.fast && p.onFast && viewing === p.agent && !fixed && (
          <div className="flex h-11 items-center gap-2.5 border-t border-line px-3">
            <Zap aria-hidden="true" className="size-4 text-ink-soft" />
            <span className="min-w-0 flex-1">
              <span className="block text-[14px] text-ink">Fast mode</span>
            </span>
            <Toggle label="Fast mode: faster answers that use more of your plan" checked={p.fast} onChange={on => p.onFast?.(on)} />
          </div>
        )}
        {p.note && <p className="border-t border-line px-3 py-2 text-[13px] text-ink-faint">{p.note}</p>}
      </div>
    </div>
  );
}

function ModelRow({
  id,
  model,
  selected,
  active,
  onPick,
  onHover,
}: {
  id: string;
  model: AgentModel;
  selected: boolean;
  active: boolean;
  onPick: () => void;
  onHover: () => void;
}) {
  return (
    // oxlint-disable-next-line jsx-a11y/click-events-have-key-events -- the search box above drives the list from the keyboard
    <div
      id={id}
      role="option"
      aria-selected={selected}
      tabIndex={-1}
      onClick={onPick}
      onMouseMove={onHover}
      className={cx("flex min-h-8 cursor-default items-center gap-2 rounded-[7px] px-2.5 py-1.5 text-[14px] text-ink select-none", active && "bg-cream-deep")}
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate">{model.label}</span>
        {model.context && <span className="block text-[13px] text-ink-soft tabular-nums">{contextNote(model.context)}</span>}
      </span>
      {selected && <Check aria-hidden="true" className="size-4 shrink-0 text-leaf" />}
    </div>
  );
}

/** The second line under a model: how much it can keep in mind at once ("1M" → "1M context window"). */
function contextNote(context: string): string {
  return `${context} context window`;
}

function OlderModels({ models, chosen, onPick }: { models: AgentModel[]; chosen: string | null; onPick: (id: string) => void }) {
  return (
    <Menu
      side="right"
      align="start"
      trigger={
        <button
          type="button"
          className="flex h-8 w-full items-center gap-1.5 rounded-[7px] px-2.5 text-left text-[14px] text-ink hover:bg-cream-deep data-[popup-open]:bg-cream-deep"
        >
          More models
          <svg aria-hidden="true" viewBox="0 0 16 16" className="size-3.5 text-ink-faint">
            <path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          {chosen && models.some(m => m.id === chosen) && <span className="ml-auto text-[13px] text-ink-faint">{modelLabel(models, chosen)}</span>}
        </button>
      }
    >
      <MenuChoice
        value={chosen ?? ""}
        onChange={v => v && onPick(v)}
        closeOnClick
        options={models.map(m => ({
          value: m.id,
          label: m.label,
          ...(m.context ? { description: contextNote(m.context) } : {}),
        }))}
      />
    </Menu>
  );
}

function EmptyList({ agent, onClose }: { agent: AgentKind; onClose: () => void }) {
  const text: ReactNode =
    agent === "acp" ? "No ACP agents saved yet. Add one with the command that starts it." : `${AGENT_LABELS[agent]} uses the model set up in its own settings.`;
  return (
    <div className="flex flex-col items-center gap-3 px-4 py-7 text-center">
      <AgentIcon kind={agent} className="size-8 text-ink-faint" />
      <p className="text-[14px] text-ink-soft">{text}</p>
      {agent === "acp" && (
        <button
          type="button"
          onClick={() => {
            onClose();
            openAgentsSettings({ tab: "acp" });
          }}
          className="text-[14px] font-semibold text-leaf hover:text-leaf-deep"
        >
          Add an ACP agent
        </button>
      )}
    </div>
  );
}
