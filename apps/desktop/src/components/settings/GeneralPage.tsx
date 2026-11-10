import { useEffect, useState } from "react";
import { useSettingsTab } from "../../lib/settingsNav.ts";
import { pairingLink } from "@lemonlime/protocol";
import { confirmAction, inDesktopShell } from "../../lib/native.ts";
import { listEditors, notificationPermission, notify, type EditorInfo } from "../../lib/system.ts";
import { allowMicrophone, listMicrophones, micOptions } from "../../lib/dictation.ts";
import type { UiPrefs } from "../../lib/storage.ts";
import { Button, TextInput, cx } from "../ui.tsx";
import type { SettingsCtx } from "./context.ts";
import { ErrorText, Pill, Row, SavedNote, Section, Select, Tabs, ToggleRow, code, useSaved } from "./parts.tsx";
import { normalizeBaseUrl } from "../../lib/cloud.ts";
import { computerPlatform, defaultComputerName, type PhoneLinkState } from "../../lib/phoneBridge.ts";
import type { PhoneAccess } from "../../lib/usePhoneLink.ts";
import { QrCode } from "../QrCode.tsx";
import { IS_MAC } from "../../lib/shortcuts.ts";
import { composing } from "../../lib/ime.ts";

const MOD = IS_MAC ? "⌘" : "Ctrl+";

type Tab = "general" | "notifications" | "awake" | "files" | "phone";

export function GeneralPage({ ctx }: { ctx: SettingsCtx }) {
  const [tab, setTab] = useSettingsTab<Tab>("general", "general", ["general", "notifications", "awake", "files", "phone"]);
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
          { id: "phone", label: "Phone" },
        ]}
      />
      {tab === "general" && <GeneralTab ctx={ctx} />}
      {tab === "notifications" && <NotificationsTab ctx={ctx} />}
      {tab === "awake" && <AwakeTab ctx={ctx} />}
      {tab === "files" && <FilesTab ctx={ctx} />}
      {tab === "phone" && <PhoneTab ctx={ctx} />}
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
        <Row
          label="Send messages with"
          description={`Shift+Enter always starts a new line. “For longer messages” sends with Enter until a message has more than one line, then with ${MOD}Enter.`}
        >
          <Select<UiPrefs["sendKey"]>
            label="Send messages with"
            value={prefs.sendKey}
            onChange={sendKey => onPrefs({ sendKey })}
            options={[
              { value: "enter", label: "Enter" },
              { value: "mod-enter", label: `${MOD}Enter` },
              { value: "mod-enter-multiline", label: `${MOD}Enter for longer messages` },
            ]}
          />
        </Row>
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
        <ToggleRow
          label="Suggest what to say next"
          description="When the agent finishes, the empty message box offers a likely reply, like “Fix the failing tests”. Press Tab to use it. Worked out on this computer; no model is asked."
          checked={prefs.suggestNextPrompt}
          onChange={suggestNextPrompt => onPrefs({ suggestNextPrompt })}
        />
        <ToggleRow
          label="Spot the wrong project"
          description="On Home, if your message names another of your projects, offer to switch to it."
          checked={prefs.projectHint}
          onChange={projectHint => onPrefs({ projectHint })}
        />
        <ToggleRow
          label="Rename vague thread titles"
          description="A thread is named from your first message. When that says little (“hi”, “fix this”), it takes its name from your next message instead. Worked out on this computer; no model is asked. Names you type yourself stay."
          checked={prefs.renameVagueTitles}
          onChange={renameVagueTitles => onPrefs({ renameVagueTitles })}
        />
        <ToggleRow
          label="Open links in the side panel"
          description="Links in the agent's replies to local pages, like localhost:3000, open in the side panel's browser. Other links still open in your usual browser."
          checked={prefs.openLinksInPanel}
          onChange={openLinksInPanel => onPrefs({ openLinksInPanel })}
        />
      </Section>
      <Section title="Voice input">
        <MicrophoneRow value={prefs.micDeviceId} onChange={micDeviceId => onPrefs({ micDeviceId })} />
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
          <p className="rounded-lg bg-lemon-soft px-3 py-2 text-[14px]">
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
        {permission === "denied" && <p className="text-[14px] text-ink-soft">Allow LemonLime in your system's notification settings, then try again.</p>}
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

const PHONE_STATE: Record<PhoneLinkState, { label: string; tone: "plain" | "good" | "warn" | "bad" }> = {
  off: { label: "Off", tone: "plain" },
  connecting: { label: "Connecting", tone: "warn" },
  live: { label: "Ready for your phone", tone: "good" },
  unavailable: { label: "Not available", tone: "warn" },
  error: { label: "Can't connect", tone: "bad" },
};

/** Phone access: drive this computer's threads from the dashboard in your phone's browser. */
function PhoneTab({ ctx }: { ctx: SettingsCtx }) {
  const { prefs, onPrefs, cloudApi, phone, settings } = ctx;
  const platform = computerPlatform();
  const [name, setName] = useState(prefs.computerName);
  const signedIn = cloudApi !== null;
  const on = prefs.phoneAccess && signedIn;
  const state = phone?.state ?? "off";
  const dashboard = normalizeBaseUrl(settings.controlPlaneUrl);
  const saveName = () => {
    const clean = name.replace(/\s+/g, " ").trim().slice(0, 100);
    setName(clean);
    if (clean !== prefs.computerName) onPrefs({ computerName: clean });
  };
  return (
    <>
      <Section
        title="Your phone"
        description="Read and answer the agents on this computer from LemonLime in your phone's browser. It stays off unless you turn it on."
        aside={on ? <Pill tone={PHONE_STATE[state].tone}>{PHONE_STATE[state].label}</Pill> : undefined}
      >
        <ToggleRow
          label="Use my local threads from my phone"
          description={
            signedIn
              ? "While it's on, this computer keeps a connection open to your dashboard. Only a phone you have paired with it can open its threads, and the dashboard's server can't read what passes between them. Turning it off cuts your phone off at once."
              : "Sign in to your dashboard under Account first. Your phone reaches this computer through it."
          }
          checked={on}
          disabled={!signedIn || !inDesktopShell()}
          onChange={next => {
            if (!next) void phone?.turnOff();
            onPrefs({ phoneAccess: next });
          }}
        />
        <Row label="This computer's name" htmlFor="computer-name" description="How the dashboard on your phone lists this computer.">
          <TextInput
            id="computer-name"
            value={name}
            maxLength={100}
            onChange={e => setName(e.target.value)}
            onBlur={saveName}
            onKeyDown={e => e.key === "Enter" && !composing(e) && saveName()}
            placeholder={defaultComputerName(platform)}
            className="w-[240px]"
            autoComplete="off"
          />
        </Row>
        {on && state === "unavailable" && (
          <p className="rounded-lg bg-lemon-soft px-3 py-2 text-[14px]">
            Your dashboard's server doesn't have phone access set up yet. Whoever runs it can turn it on.
          </p>
        )}
        {on && state === "error" && phone?.detail && <ErrorText>{phone.detail}</ErrorText>}
        {on && dashboard && <PairPhone dashboard={dashboard} phone={phone} />}
      </Section>
      {on && (
        <Section title="What your phone can do">
          <p className="text-[14px] text-ink-soft">
            Your phone can follow a thread, send messages, answer questions and approve or decline what the agent asks to do. It can't open a terminal, browse
            or download files, use this computer's apps, sign the agent in, or give the agent full access. Those stay here.
          </p>
        </Section>
      )}
    </>
  );
}

/**
 * Pairing a phone with this computer. The code holds the key that seals everything between
 * the two, so it is only on screen while the user asks to see it: this component's state is
 * gone, and the code with it, as soon as Settings closes or another tab is opened.
 */
function PairPhone({ dashboard, phone }: { dashboard: string; phone: PhoneAccess | undefined }) {
  const [shown, setShown] = useState(false);
  const [copied, markCopied] = useSaved();
  const [unpaired, markUnpaired] = useSaved();
  const pairing = phone?.pairing ?? null;
  const link = pairing ? pairingLink(dashboard, pairing) : null;
  const unpairAll = async () => {
    if (!(await confirmAction("Unpair all phones? Every phone paired with this computer stops working until you pair it again."))) return;
    setShown(false);
    await phone?.unpairAll();
    markUnpaired();
  };
  return (
    <>
      <Row label="Pair a phone" description="A phone is paired once, by scanning a code from this screen. Until then it can't open this computer's threads.">
        <Button disabled={!link} aria-expanded={shown} onClick={() => setShown(s => !s)}>
          {shown ? "Hide the code" : "Pair a phone"}
        </Button>
      </Row>
      {shown && link && (
        <div className="flex flex-wrap items-start gap-5">
          <QrCode text={link} label="Pairing code for your phone" px={196} />
          <div className="min-w-0 flex-1 basis-[240px]">
            <p className="text-[14px] text-ink">
              Scan this with your phone's camera. It pairs the phone with this computer; the code never leaves your devices.
            </p>
            <p className="mt-2 text-[14px] text-ink-soft">
              Treat it like a key. Anyone who has it and can sign in to your dashboard can use this computer's threads.
            </p>
            <p className={cx(code, "mt-3 rounded-lg bg-cream-deep px-3 py-2 break-all select-all")}>{link}</p>
            <div className="mt-3 flex items-center gap-2">
              <Button
                onClick={() => {
                  void navigator.clipboard?.writeText(link).then(markCopied, () => undefined);
                }}
              >
                Copy link
              </Button>
              <SavedNote show={copied} text="Copied" />
            </div>
          </div>
        </div>
      )}
      {pairing && !pairing.kept && (
        <p className="rounded-lg bg-lemon-soft px-3 py-2 text-[14px]">
          This computer couldn't save the pairing code, so phones will need pairing again after LemonLime restarts.
        </p>
      )}
      <Row label="Unpair all phones" description="Makes a new code. Every phone paired with this computer stops working until you pair it again.">
        <SavedNote show={unpaired} text="Unpaired" />
        <Button variant="danger" disabled={!pairing} onClick={() => void unpairAll()}>
          Unpair all phones
        </Button>
      </Row>
    </>
  );
}

/** Which microphone the dictation meter listens on. */
function MicrophoneRow({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const [mics, setMics] = useState<MediaDeviceInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    const load = () => void listMicrophones().then(m => live && setMics(m));
    load();
    navigator.mediaDevices?.addEventListener?.("devicechange", load);
    return () => {
      live = false;
      navigator.mediaDevices?.removeEventListener?.("devicechange", load);
    };
  }, []);
  const options = micOptions(mics ?? []);
  // Until the microphone has been allowed once, the system keeps the names to itself.
  const unnamed = (mics ?? []).length > 0 && !(mics ?? []).some(m => m.label);
  return (
    <>
      <Row
        label="Microphone"
        description="The level meter listens on this one while you dictate. Speech recognition uses your system's default microphone, so pick the same one in your system's sound settings."
      >
        <Select label="Microphone" value={options.some(o => o.value === value) ? value : ""} onChange={onChange} options={options} className="w-[240px]" />
      </Row>
      {(unnamed || mics?.length === 0) && (
        <div className="flex flex-wrap items-center gap-3 border-t border-line pt-4">
          {mics?.length === 0 ? (
            <p className="text-[14px] text-ink-soft">No microphone found.</p>
          ) : (
            <Button
              onClick={() => {
                setError(null);
                void allowMicrophone().then(
                  () => listMicrophones().then(setMics),
                  () => setError("LemonLime isn't allowed to use the microphone. Turn it on in your system's privacy settings."),
                );
              }}
            >
              Show microphone names
            </Button>
          )}
          <ErrorText>{error}</ErrorText>
        </div>
      )}
    </>
  );
}
