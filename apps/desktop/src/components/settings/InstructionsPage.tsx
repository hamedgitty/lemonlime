import { useCallback, useEffect, useRef, useState } from "react";
import { useSettingsTab } from "../../lib/settingsNav.ts";
import { listSkills, type SkillInfo } from "../../lib/native.ts";
import type { SettingsCtx } from "./context.ts";
import { RetryCard } from "../ui.tsx";
import { Pill, SavedNote, Section, Tabs, ToggleRow, useSaved } from "./parts.tsx";

const MAX = 32_000;

export function InstructionsPage({ ctx }: { ctx: SettingsCtx }) {
  const [tab, setTab] = useSettingsTab<"custom" | "builtin">("instructions", "custom", ["custom", "builtin"]);
  return (
    <>
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { id: "custom", label: "Custom instructions" },
          { id: "builtin", label: "Built-in skills" },
        ]}
      />
      {tab === "custom" ? <CustomTab ctx={ctx} /> : <BuiltinTab ctx={ctx} />}
    </>
  );
}

function CustomTab({ ctx }: { ctx: SettingsCtx }) {
  const { settings, onSave } = ctx;
  const [text, setText] = useState(settings.instructions);
  const [saved, markSaved] = useSaved();
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const latest = useRef(settings);
  latest.current = settings;
  const now = useRef({ text, onSave });
  now.current = { text, onSave };
  // Saves a moment after you stop typing.
  useEffect(() => {
    if (text === latest.current.instructions) return;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      onSave({ ...latest.current, instructions: text.slice(0, MAX) });
      markSaved();
    }, 600);
    return () => clearTimeout(timer.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);
  // Leaving the page before that moment is up still saves what was typed.
  useEffect(
    () => () => {
      const { text, onSave } = now.current;
      if (text !== latest.current.instructions) onSave({ ...latest.current, instructions: text.slice(0, MAX) });
    },
    [],
  );
  return (
    <Section
      title="Custom instructions"
      description="Told to every agent on this computer at the start of each thread: how you like to work, your stack, what to avoid. For cloud threads, set them under Cloud."
      aside={<SavedNote show={saved} />}
    >
      <textarea
        aria-label="Custom instructions"
        value={text}
        onChange={e => setText(e.target.value)}
        rows={12}
        maxLength={MAX}
        placeholder={
          "For example:\nUse pnpm, not npm.\nWrite tests for every change and run them before you finish.\nKeep commit messages short and in plain English."
        }
        className="w-full resize-y rounded-lg border border-line-strong bg-paper px-3 py-2.5 text-[14px] leading-relaxed text-ink placeholder:text-ink-faint focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-leaf"
      />
      <p className="text-[13px] text-ink-faint tabular-nums">
        {text.length.toLocaleString()} of {MAX.toLocaleString()} characters. Applies to threads started after you change it.
      </p>
    </Section>
  );
}

function BuiltinTab({ ctx }: { ctx: SettingsCtx }) {
  const { settings, onSave } = ctx;
  const [skills, setSkills] = useState<SkillInfo[] | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const load = useCallback(() => {
    setFailed(null);
    listSkills().then(
      list => setSkills(list.filter(s => s.source === "bundled")),
      e => setFailed(e instanceof Error ? e.message : String(e)),
    );
  }, []);
  useEffect(() => load(), [load]);
  const on = (name: string) => !settings.disabledSkills.includes(name);
  return (
    <Section
      title="Built-in skills"
      description="LemonLime's own skills teach agents how to use it: opening previews, starting helpers, keeping to the thread's branch. Turn off any you don't want copied into new threads."
      aside={skills ? <Pill>{skills.filter(s => on(s.name)).length} on</Pill> : undefined}
    >
      {skills === null && !failed && <p className="text-[14px] text-ink-soft">Loading…</p>}
      {skills === null && failed && <RetryCard title="The built-in skills didn't load" detail={failed} onRetry={load} />}
      {skills?.length === 0 && <p className="text-[14px] text-ink-soft">Shown in the desktop app.</p>}
      {skills?.map(s => (
        <ToggleRow
          key={s.name}
          label={s.name}
          description={s.description || undefined}
          checked={on(s.name)}
          onChange={v => onSave({ ...settings, disabledSkills: v ? settings.disabledSkills.filter(n => n !== s.name) : [...settings.disabledSkills, s.name] })}
        />
      ))}
    </Section>
  );
}
