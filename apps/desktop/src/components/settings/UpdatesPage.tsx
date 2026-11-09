import { useState } from "react";
import { ExternalLink } from "lucide-react";
import { inDesktopShell } from "../../lib/native.ts";
import { checkForUpdate, type AvailableUpdate } from "../../lib/updates.ts";
import { AGENT_LABELS } from "../../lib/format.ts";
import { Button, Spinner, openExternal } from "../ui.tsx";
import { needsUpdate } from "../../lib/models.ts";
import type { SettingsCtx } from "./context.ts";
import { Pill, Row, Section } from "./parts.tsx";

const LINKS: [string, string, string][] = [
  ["Website", "lemonlime.dev", "https://lemonlime.dev"],
  ["Source code", "Open source, MIT licensed", "https://github.com/hamedgitty/lemonlime"],
  ["Guides", "Self-hosting, sandboxes, skills and plugins", "https://github.com/hamedgitty/lemonlime/tree/main/docs"],
  ["What's new", "Every release and what changed", "https://github.com/hamedgitty/lemonlime/releases"],
  ["Report a problem", "Or ask for something", "https://github.com/hamedgitty/lemonlime/issues/new"],
];

export function UpdatesPage({ ctx }: { ctx: SettingsCtx }) {
  const [state, setState] = useState<"idle" | "checking" | "current" | "available" | "installing" | "error">("idle");
  const [update, setUpdate] = useState<AvailableUpdate | null>(null);
  const [progress, setProgress] = useState(0);
  const check = async () => {
    setState("checking");
    const u = await checkForUpdate();
    setUpdate(u);
    setState(u ? "available" : "current");
  };
  const install = async () => {
    if (!update) return;
    setState("installing");
    try {
      await update.install({ onProgress: setProgress });
      // Still here: the restart was put off while an agent works. The update waits for it.
      setState("available");
    } catch {
      setState("error");
    }
  };
  const outdated = (ctx.agents ?? []).filter(needsUpdate);
  return (
    <>
      <Section title="LemonLime" description="LemonLime checks for new versions when it starts and installs them when you say so. Every update is signed.">
        <Row label="Version" description="The version of this app.">
          <span className="font-mono text-[14px]">{import.meta.env.VITE_APP_VERSION ?? "0.1.0"}</span>
        </Row>
        <Row
          label="Updates"
          description={
            state === "current"
              ? "You're on the latest version."
              : state === "available" && update
                ? `Version ${update.version} is ready to install.`
                : state === "installing"
                  ? `Installing${progress ? ` (${Math.round(progress * 100)}%)` : ""}… LemonLime restarts when it's done.`
                  : state === "error"
                    ? "The update didn't install. Try again later."
                    : inDesktopShell()
                      ? "Check whether a newer version is out."
                      : "Updates only work in the desktop app."
          }
        >
          {state === "available" ? (
            <Button variant="primary" onClick={() => void install()}>
              Install and restart
            </Button>
          ) : (
            <Button onClick={() => void check()} disabled={!inDesktopShell() || state === "checking" || state === "installing"}>
              {state === "checking" && <Spinner />}
              Check now
            </Button>
          )}
        </Row>
        <Row
          label="Agents"
          description={
            ctx.agents === null
              ? "Checking…"
              : outdated.length
                ? `${outdated.map(a => AGENT_LABELS[a.kind]).join(" and ")} can be updated.`
                : "Every installed agent is up to date."
          }
        >
          {outdated.length > 0 && <Pill tone="warn">{outdated.length} to update</Pill>}
          <Button size="sm" variant="ghost" onClick={() => ctx.onPage("agents")}>
            Open Agents
          </Button>
        </Row>
      </Section>
      <Section title="Community">
        {LINKS.map(([label, description, url]) => (
          <Row key={url} label={label} description={description}>
            <Button size="sm" variant="ghost" onClick={() => void openExternal(url)}>
              Open
              <ExternalLink aria-hidden="true" className="size-3.5" />
            </Button>
          </Row>
        ))}
      </Section>
    </>
  );
}
