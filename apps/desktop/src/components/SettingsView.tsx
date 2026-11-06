import { useState, type FormEvent, type ReactNode } from "react";
import { Check, Eye, EyeOff } from "lucide-react";
import type { Settings } from "../lib/storage.ts";
import { CloudApi, CloudError, normalizeBaseUrl } from "../lib/cloud.ts";
import { inDesktopShell } from "../lib/native.ts";
import { Button, Field, Spinner, TextInput, openExternal } from "./ui.tsx";

export function SettingsView({ settings, onSave }: { settings: Settings; onSave: (s: Settings) => void }) {
  const [runnerPath, setRunnerPath] = useState(settings.runnerPath);
  const [url, setUrl] = useState(settings.controlPlaneUrl);
  const [token, setToken] = useState(settings.accessToken);
  const [showToken, setShowToken] = useState(false);
  const [saved, setSaved] = useState(false);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<{ ok: boolean; message: string; actionUrl?: string; actionLabel?: string } | null>(null);
  const [urlError, setUrlError] = useState<string | null>(null);

  const validUrl = (value: string) => value.trim() === "" || /^https?:\/\/[^\s]+$/i.test(value.trim());

  const save = (e: FormEvent) => {
    e.preventDefault();
    if (!validUrl(url)) {
      setUrlError("Use a full URL starting with http:// or https://");
      return;
    }
    setUrlError(null);
    onSave({ runnerPath: runnerPath.trim(), controlPlaneUrl: url.trim() ? normalizeBaseUrl(url) : "", accessToken: token.trim() });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const testConnection = async () => {
    if (!url.trim() || !validUrl(url)) {
      setUrlError("Use a full URL starting with http:// or https://");
      return;
    }
    setUrlError(null);
    setTesting(true);
    setTest(null);
    try {
      const threads = await new CloudApi({ url, token: token.trim() }).listThreads();
      setTest({ ok: true, message: `Connected. ${threads.length === 1 ? "1 cloud thread" : `${threads.length} cloud threads`} found.` });
    } catch (err) {
      if (err instanceof CloudError && err.denial) {
        setTest({
          ok: false,
          message: err.denial.reason,
          ...(err.denial.actionUrl ? { actionUrl: err.denial.actionUrl } : {}),
          ...(err.denial.actionLabel ? { actionLabel: err.denial.actionLabel } : {}),
        });
      } else setTest({ ok: false, message: err instanceof Error ? err.message : String(err) });
    } finally {
      setTesting(false);
    }
  };

  return (
    <main className="scroll-thin min-w-0 flex-1 overflow-y-auto">
      <form onSubmit={save} className="mx-auto flex max-w-[680px] flex-col gap-6 px-8 py-10">
        <div>
          <h1 className="text-[26px] font-semibold text-ink">Settings</h1>
          <p className="mt-1 text-ink-soft">Saved on this computer only.</p>
        </div>

        <Card title="Local threads" description="Local threads run the agent on this computer, in the repository folder you choose.">
          <Field
            label="Runner binary"
            htmlFor="runner-path"
            hint={
              <>
                Leave empty to use <span className="font-mono text-[12px] text-ink">lemonlime-runner</span> from your PATH.
              </>
            }
          >
            <TextInput
              id="runner-path"
              value={runnerPath}
              onChange={e => setRunnerPath(e.target.value)}
              placeholder="lemonlime-runner"
              className="font-mono text-[13px]"
              autoComplete="off"
              spellCheck={false}
            />
          </Field>
          {!inDesktopShell() && (
            <p className="rounded-lg bg-lemon-soft px-3 py-2 text-[13px] text-ink">
              You are viewing the app in a browser. Local threads only work inside the desktop app.
            </p>
          )}
        </Card>

        <Card
          title="Cloud threads"
          description="Connect to a LemonLime control plane to run threads in cloud sandboxes. Create an access token in its dashboard."
        >
          <Field label="Control plane URL" htmlFor="cp-url" error={urlError}>
            <TextInput
              id="cp-url"
              type="url"
              value={url}
              onChange={e => setUrl(e.target.value)}
              placeholder="http://localhost:3000"
              autoComplete="off"
              spellCheck={false}
            />
          </Field>
          <Field label="Access token" htmlFor="cp-token">
            <div className="relative">
              <TextInput
                id="cp-token"
                type={showToken ? "text" : "password"}
                value={token}
                onChange={e => setToken(e.target.value)}
                placeholder="Paste a personal access token"
                className="pr-10 font-mono text-[13px]"
                autoComplete="off"
                spellCheck={false}
              />
              <button
                type="button"
                onClick={() => setShowToken(s => !s)}
                aria-label={showToken ? "Hide token" : "Show token"}
                aria-pressed={showToken}
                className="absolute top-1/2 right-1.5 inline-flex size-7 -translate-y-1/2 items-center justify-center rounded-md text-ink-faint hover:bg-ink/5 hover:text-ink"
              >
                {showToken ? <EyeOff aria-hidden="true" className="size-4" /> : <Eye aria-hidden="true" className="size-4" />}
              </button>
            </div>
          </Field>
          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={testConnection} disabled={testing || !url.trim()}>
              {testing && <Spinner />}
              Test connection
            </Button>
            {test && (
              <p role="status" className={test.ok ? "text-[13px] text-leaf" : "text-[13px] text-danger"}>
                {test.message}
                {test.actionUrl && (
                  <>
                    {" "}
                    <button
                      type="button"
                      onClick={() => void openExternal(test.actionUrl!)}
                      className="font-medium text-ink underline underline-offset-2"
                    >
                      {test.actionLabel || "Learn more"}
                    </button>
                  </>
                )}
              </p>
            )}
          </div>
        </Card>

        <div className="flex items-center gap-3">
          <Button type="submit" variant="primary">
            Save settings
          </Button>
          {saved && (
            <span role="status" className="inline-flex items-center gap-1.5 text-[13px] text-leaf">
              <Check aria-hidden="true" className="size-4" />
              Saved
            </span>
          )}
        </div>
      </form>
    </main>
  );
}

function Card({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-4 rounded-2xl border border-line bg-white p-6 shadow-panel">
      <div>
        <h2 className="text-[17px] font-semibold text-ink">{title}</h2>
        <p className="mt-0.5 text-[13.5px] text-ink-soft">{description}</p>
      </div>
      {children}
    </section>
  );
}
