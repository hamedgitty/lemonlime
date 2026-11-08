import { useEffect, useState } from "react";
import { inDesktopShell } from "../../lib/native.ts";
import { listEditors, notificationPermission, notify, type EditorInfo } from "../../lib/system.ts";
import type { UiPrefs } from "../../lib/storage.ts";
import { Button, TextInput } from "../ui.tsx";
import type { SettingsCtx } from "./context.ts";
import { Pill, Row, SavedNote, Section, Select, Tabs, ToggleRow, useSaved } from "./parts.tsx";

type Tab = "general" | "notifications" | "awake" | "files";

export function GeneralPage({ ctx }: { ctx: SettingsCtx }) {
  const [tab, setTab] = useState<Tab>("general");
  return (
    <>
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { id: "general", label: "General" },
          { id: "notifications", label: "Notifications" },
          { id: "awake", label: "Keep awake" },
          { id: "files", label: "Files" },
        ]}
      />
      {tab === "general" && <GeneralTab ctx={ctx} />}
      {tab === "notifications" && <NotificationsTab ctx={ctx} />}
      {tab === "awake" && <AwakeTab ctx={ctx} />}
      {tab === "files" && <FilesTab ctx={ctx} />}
    </>
  );
}

function GeneralTab({ ctx }: { ctx: SettingsCtx }) {
  const { settings, onSave, prefs, onPrefs } = ctx;
  const [runnerPath, setRunnerPath] = useState(settings.runnerPath);
  const [saved, markSaved] = useSaved();
  return (
    <>
      <Section title="Threads">
        <ToggleRow
          label="Open new threads right away"
          description="Go to a thread as soon as you start it. Off, you stay where you are and it shows up in the sidebar."
          checked={prefs.navigateOnCreate}
          onChange={navigateOnCreate => onPrefs({ navigateOnCreate })}
        />
        <Row label="While the agent is working, Enter…" description="You can always do the other from the message's menu.">
          <Select<UiPrefs["followUp"]>
            label="While the agent is working, Enter"
            value={prefs.followUp}
            onChange={followUp => onPrefs({ followUp })}
            options={[
              { value: "queue", label: "Queues the message" },
              { value: "steer", label: "Sends it now (steer)" },
            ]}
          />
        </Row>
      </Section>
      <Section
        title="Threads on this computer"
        description="Each local thread works in its own copy of your repository (a git worktree), so your branch and unsaved work are never touched."
      >
        <Row label="Runner" htmlFor="runner-path" description="Leave empty to use the runner that comes with LemonLime, or lemonlime-runner on your PATH.">
          <TextInput
            id="runner-path"
            value={runnerPath}
            onChange={e => setRunnerPath(e.target.value)}
            placeholder="lemonlime-runner"
            className="w-[280px] font-mono text-[13px]"
            autoComplete="off"
            spellCheck={false}
          />
        </Row>
        {!inDesktopShell() && (
          <p className="rounded-lg bg-lemon-soft px-3 py-2 text-[13.5px]">
            You're viewing LemonLime in a browser. Threads on this computer only run inside the desktop app.
          </p>
        )}
        <div className="flex items-center gap-3 border-t border-line pt-4">
          <Button
            variant="primary"
            onClick={() => {
              onSave({ ...settings, runnerPath: runnerPath.trim() });
              markSaved();
            }}
          >
            Save
          </Button>
          <SavedNote show={saved} />
        </div>
      </Section>
    </>
  );
}

function NotificationsTab({ ctx }: { ctx: SettingsCtx }) {
  const n = ctx.prefs.notifications;
  const set = (patch: Partial<UiPrefs["notifications"]>) => ctx.onPrefs({ notifications: { ...n, ...patch } });
  const [permission, setPermission] = useState<"granted" | "denied" | "unknown">("unknown");
  const [sent, markSent] = useSaved();
  useEffect(() => {
    void notificationPermission(false).then(setPermission);
  }, []);
  return (
    <Section
      title="Notifications"
      description="Hear about it when an agent finishes, gets stuck or needs you, on this computer and in the cloud."
      aside={
        <Pill tone={permission === "granted" ? "good" : permission === "denied" ? "warn" : "plain"}>
          {permission === "granted" ? "Allowed" : permission === "denied" ? "Not allowed yet" : "Desktop app only"}
        </Pill>
      }
    >
      <ToggleRow label="Notifications" checked={n.enabled} onChange={enabled => set({ enabled })} />
      <ToggleRow label="When an agent finishes" checked={n.finished} disabled={!n.enabled} onChange={finished => set({ finished })} />
      <ToggleRow label="When something fails" checked={n.failed} disabled={!n.enabled} onChange={failed => set({ failed })} />
      <ToggleRow
        label="When an agent needs you"
        description="It asked to run a command, or wants an answer."
        checked={n.needsInput}
        disabled={!n.enabled}
        onChange={needsInput => set({ needsInput })}
      />
      <ToggleRow
        label="Even for the thread I'm looking at"
        description="Off, you're only told about threads you aren't watching."
        checked={n.whenFocused}
        disabled={!n.enabled}
        onChange={whenFocused => set({ whenFocused })}
      />
      <div className="flex flex-wrap items-center gap-3 border-t border-line pt-4">
        <Button
          disabled={!inDesktopShell()}
          onClick={async () => {
            const p = await notificationPermission(true);
            setPermission(p);
            if (await notify("LemonLime", "Notifications are on. You'll hear from your agents here.")) markSent();
          }}
        >
          Send a test notification
        </Button>
        <SavedNote show={sent} text="Sent" />
        {permission === "denied" && <p className="text-[13.5px] text-ink-soft">Allow LemonLime in your system's notification settings, then try again.</p>}
      </div>
    </Section>
  );
}

function AwakeTab({ ctx }: { ctx: SettingsCtx }) {
  const { prefs, onPrefs } = ctx;
  return (
    <Section title="Keep awake" description="Agents on this computer stop when it sleeps. Cloud agents carry on either way.">
      <ToggleRow
        label="Keep this computer awake while agents work"
        description="Only while an agent on this computer is working; it sleeps as usual otherwise. Closing a laptop's lid still puts it to sleep."
        checked={prefs.keepAwake}
        onChange={keepAwake => onPrefs({ keepAwake })}
      />
      <ToggleRow
        label="Keep the screen on too"
        checked={prefs.keepDisplayOn}
        disabled={!prefs.keepAwake}
        onChange={keepDisplayOn => onPrefs({ keepDisplayOn })}
      />
    </Section>
  );
}

function FilesTab({ ctx }: { ctx: SettingsCtx }) {
  const [editors, setEditors] = useState<EditorInfo[] | null>(null);
  useEffect(() => {
    void listEditors().then(setEditors, () => setEditors([]));
  }, []);
  const options = [{ value: "", label: "File manager" }, ...(editors ?? []).map(e => ({ value: e.id, label: e.name }))];
  return (
    <Section title="Opening files" description="Where a thread's folder opens when you choose Open in editor.">
      <Row
        label="Open folders in"
        description={editors && editors.length === 0 ? "No code editor found on this computer, so folders open in your file manager." : undefined}
      >
        <Select label="Open folders in" value={ctx.prefs.editor} onChange={editor => ctx.onPrefs({ editor })} options={options} />
      </Row>
    </Section>
  );
}
