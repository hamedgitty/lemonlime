import { useEffect, useState } from "react";
import { RotateCcw, Search } from "lucide-react";
import { comboOf, FIXED_SHORTCUTS, keyCaps, keysFor, SHORTCUTS, validCombo, type ShortcutId } from "../../lib/shortcuts.ts";
import { Kbd } from "../primitives.tsx";
import { Button, IconButton, TextInput, cx } from "../ui.tsx";
import type { SettingsCtx } from "./context.ts";
import { ErrorText, Section } from "./parts.tsx";

export function KeyboardPage({ ctx }: { ctx: SettingsCtx }) {
  const { prefs, onPrefs } = ctx;
  const [query, setQuery] = useState("");
  const [recording, setRecording] = useState<ShortcutId | null>(null);
  const [error, setError] = useState<string | null>(null);
  const overrides = prefs.shortcuts;

  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") return setRecording(null);
      const combo = comboOf(e);
      if (!combo) return;
      if (!validCombo(combo)) return setError("Use ⌘ (or Ctrl) or Alt with the key, so typing never sets it off.");
      const clash = SHORTCUTS.find(s => s.id !== recording && keysFor(s.id, overrides) === combo);
      if (clash) return setError(`That's already “${clash.label}”. Change that one first.`);
      setError(null);
      const def = SHORTCUTS.find(s => s.id === recording)!.keys;
      const next = { ...overrides };
      if (combo === def) delete next[recording];
      else next[recording] = combo;
      onPrefs({ shortcuts: next });
      setRecording(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [recording, overrides, onPrefs]);

  const q = query.trim().toLowerCase();
  const groups = [...new Set(SHORTCUTS.map(s => s.group))];
  const changed = Object.keys(overrides).length > 0;

  return (
    <>
      <div className="mb-5 flex items-center gap-2">
        <label className="relative flex-1">
          <Search aria-hidden="true" className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-ink-faint" />
          <TextInput
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search shortcuts"
            aria-label="Search shortcuts"
            className="w-full pl-8"
          />
        </label>
        <Button variant="ghost" disabled={!changed} onClick={() => onPrefs({ shortcuts: {} })}>
          Reset all
        </Button>
      </div>
      <ErrorText>{error}</ErrorText>
      {groups.map(group => {
        const items = SHORTCUTS.filter(s => s.group === group && s.label.toLowerCase().includes(q));
        if (!items.length) return null;
        return (
          <Section key={group} title={group}>
            <ul className="flex flex-col gap-3">
              {items.map(s => {
                const keys = keysFor(s.id, overrides);
                const isRecording = recording === s.id;
                return (
                  <li key={s.id} className="flex items-center gap-3">
                    <span className="flex-1 text-[15px]">{s.label}</span>
                    <button
                      type="button"
                      onClick={() => (setError(null), setRecording(isRecording ? null : s.id))}
                      aria-label={isRecording ? `Press the new keys for ${s.label}, or Escape` : `Change ${s.label}`}
                      className={cx(
                        "inline-flex h-8 min-w-[110px] items-center justify-center gap-1 rounded-lg border px-2 text-[13px]",
                        isRecording ? "border-leaf bg-lime-soft text-ink" : "border-line hover:border-line-strong",
                      )}
                    >
                      {isRecording ? "Press keys…" : keys ? keyCaps(keys).map(k => <Kbd key={k}>{k}</Kbd>) : <span className="text-ink-faint">Off</span>}
                    </button>
                    <IconButton
                      label={`Reset ${s.label}`}
                      disabled={!(s.id in overrides)}
                      onClick={() => {
                        const next = { ...overrides };
                        delete next[s.id];
                        onPrefs({ shortcuts: next });
                      }}
                    >
                      <RotateCcw aria-hidden="true" className="size-4" />
                    </IconButton>
                  </li>
                );
              })}
            </ul>
          </Section>
        );
      })}
      <Section title="Always">
        <dl className="grid grid-cols-[1fr_auto] gap-x-6 gap-y-3">
          {FIXED_SHORTCUTS.filter(([, what]) => what.toLowerCase().includes(q)).map(([keys, what]) => (
            <div key={keys} className="contents">
              <dt className="text-[15px]">{what}</dt>
              <dd className="flex gap-1">
                {keys.split(" ").map(k => (
                  <Kbd key={k}>{k}</Kbd>
                ))}
              </dd>
            </div>
          ))}
        </dl>
      </Section>
    </>
  );
}
