import { useEffect, useMemo, useRef, useState } from "react";
import { ExternalLink, Globe, RotateCw } from "lucide-react";
import type { Preview, ThreadEvent } from "@lemonlime/protocol";
import type { Connection } from "../lib/useThreadSession.ts";
import { inDesktopShell, previewTunnelToken, startPreviewTunnel, stopPreviewTunnel } from "../lib/native.ts";
import { Tip } from "./primitives.tsx";
import { cx, openExternal } from "./ui.tsx";

const TOKEN_REFRESH_MS = 10 * 60_000;

/**
 * What the agent offered for preview. On this computer that's localhost already; for a cloud
 * thread the app opens a private tunnel on 127.0.0.1 to the sandbox's port, so nothing is on
 * the internet.
 */
export function PreviewPanel({
  events,
  mode,
  connection,
  runnerPath,
}: {
  events: ThreadEvent[];
  mode: "local" | "cloud";
  connection: Connection | null;
  runnerPath?: string;
}) {
  const previews = useMemo(() => {
    const last = [...events].reverse().find(e => e.type === "preview_update");
    return last?.type === "preview_update" ? last.previews : [];
  }, [events]);
  const [port, setPort] = useState<number | null>(null);
  const [local, setLocal] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  // The page within the preview: typed in the address bar, kept per preview.
  const [path, setPath] = useState("/");
  const [typed, setTyped] = useState("/");
  const frame = useRef<HTMLIFrameElement>(null);
  const current: Preview | undefined = previews.find(p => p.port === port) ?? previews[0];

  useEffect(() => {
    setError(null);
    setLocal(null);
    if (!current) return;
    if (mode === "local") return setLocal(current.port);
    if (!connection) return setError("The preview opens once the thread is running.");
    if (!inDesktopShell()) return setError("Cloud previews open in the LemonLime desktop app.");
    let cancelled = false;
    const url = connection.url;
    void connection
      .token()
      .then(t => startPreviewTunnel(url, current.port, t, runnerPath))
      .then(p => !cancelled && setLocal(p))
      .catch(e => !cancelled && setError(e instanceof Error ? e.message : String(e)));
    const refresh = setInterval(() => void connection.token().then(t => previewTunnelToken(url, current.port, t)), TOKEN_REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(refresh);
      void stopPreviewTunnel(url, current.port);
    };
  }, [current, mode, connection, runnerPath]);

  if (!previews.length) {
    return (
      <div role="tabpanel" aria-label="Browser" className="scroll-thin min-h-0 flex-1 overflow-y-auto p-3">
        <p className="rounded-lg border border-dashed border-line-strong px-4 py-8 text-center text-[14px] text-ink-soft">
          When the agent starts a dev server, it shows up here to open.
        </p>
      </div>
    );
  }
  const origin = local ? `http://127.0.0.1:${local}` : null;
  const address = origin ? `${origin}${path}` : null;
  const go = (value: string) => {
    let next = value.trim() || "/";
    // A full local address on the same port keeps just its path.
    const m = /^(?:https?:\/\/)?(?:localhost|127\.0\.0\.1)(?::\d+)?(\/.*)?$/i.exec(next);
    if (m) next = m[1] ?? "/";
    if (!next.startsWith("/")) next = `/${next}`;
    setPath(next);
    setTyped(next);
    setReload(r => r + 1);
  };
  return (
    <div role="tabpanel" aria-label="Browser" className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-11 items-center gap-1 border-b border-line px-2 py-1.5">
        <div className="flex min-w-0 flex-1 gap-1 overflow-x-auto">
          {previews.map(p => (
            <button
              key={p.port}
              type="button"
              aria-pressed={p.port === current?.port}
              onClick={() => {
                setPort(p.port);
                setPath("/");
                setTyped("/");
              }}
              className={cx(
                "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-lg px-2 text-[13px]",
                p.port === current?.port ? "bg-cream-deep text-ink" : "text-ink-soft hover:bg-cream-deep/60",
              )}
            >
              <Globe aria-hidden="true" className="size-3.5" />
              {p.name}
              <span className="font-mono text-[12px] text-ink-faint">:{p.port}</span>
            </button>
          ))}
        </div>
        <Tip label="Reload" side="bottom">
          <button
            type="button"
            aria-label="Reload preview"
            disabled={!address}
            onClick={() => setReload(r => r + 1)}
            className="inline-flex size-7 items-center justify-center rounded-lg text-ink-soft hover:bg-cream-deep disabled:opacity-50"
          >
            <RotateCw aria-hidden="true" className="size-4" />
          </button>
        </Tip>
        <Tip label="Open in your browser" side="bottom">
          <button
            type="button"
            aria-label="Open preview in your browser"
            disabled={!address}
            onClick={() => address && void openExternal(address)}
            className="inline-flex size-7 items-center justify-center rounded-lg text-ink-soft hover:bg-cream-deep disabled:opacity-50"
          >
            <ExternalLink aria-hidden="true" className="size-4" />
          </button>
        </Tip>
      </div>
      <form
        onSubmit={e => {
          e.preventDefault();
          go(typed);
        }}
        className="flex items-center gap-1.5 border-b border-line px-2 py-1.5"
      >
        <span className="shrink-0 font-mono text-[12px] text-ink-faint">{origin ? origin.replace("http://", "") : ""}</span>
        <input
          value={typed}
          onChange={e => setTyped(e.target.value)}
          aria-label="Page to open"
          spellCheck={false}
          disabled={!origin}
          className="h-7 min-w-0 flex-1 rounded-md border border-line bg-paper px-2 font-mono text-[12.5px] text-ink outline-none focus:border-leaf disabled:opacity-50"
        />
      </form>
      {error ? (
        <p role="alert" className="m-3 text-[13.5px] text-danger">
          {error}
        </p>
      ) : address ? (
        <iframe
          key={`${address}#${reload}`}
          ref={frame}
          title={current?.name ?? "Preview"}
          src={address}
          sandbox="allow-scripts allow-forms allow-same-origin allow-popups allow-modals"
          className="min-h-0 w-full flex-1 bg-paper"
        />
      ) : (
        <p role="status" className="m-3 text-[13.5px] text-ink-soft">
          Opening {current?.name}…
        </p>
      )}
    </div>
  );
}
