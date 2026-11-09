import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Globe, Plus, Radio, X } from "lucide-react";
import type { Preview, ThreadEvent } from "@lemonlime/protocol";
import type { Connection } from "../lib/useThreadSession.ts";
import { shortAddress } from "../lib/browser.ts";
import { inDesktopShell, previewTunnelToken, startPreviewTunnel, stopPreviewTunnel } from "../lib/native.ts";
import { BrowserView, NewTabPage } from "./PanelBrowser.tsx";
import { Tip } from "./primitives.tsx";
import { ICON_BUTTON, cx } from "./ui.tsx";

const TOKEN_REFRESH_MS = 10 * 60_000;

type View = { kind: "preview"; port: number } | { kind: "page"; url: string } | { kind: "new" };

/** The port of a local address (localhost, 127.0.0.1, [::1]), or null. */
export function localPort(url: string): number | null {
  try {
    const u = new URL(url);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)) return null;
    return Number(u.port || (u.protocol === "https:" ? 443 : 80));
  } catch {
    return null;
  }
}

/** A path typed for a preview: "settings", "/a?b" or a full local address on any port keep just the path. */
export function previewPath(typed: string): string {
  let next = typed.trim() || "/";
  const m = /^(?:https?:\/\/)?(?:localhost|127\.0\.0\.1)(?::\d+)?(\/.*)?$/i.exec(next);
  if (m) next = m[1] ?? "/";
  return next.startsWith("/") ? next : `/${next}`;
}

/**
 * The thread panel's browser: what the agent offered for preview, and any other address.
 * On this computer a preview is on localhost already; for a cloud thread the app opens a
 * private tunnel on 127.0.0.1 to the sandbox's port, so nothing is on the internet.
 */
export function PreviewPanel({
  events,
  mode,
  connection,
  runnerPath,
  onFindFile,
  findFileKeys,
  open,
  onOfferPort,
}: {
  events: ThreadEvent[];
  mode: "local" | "cloud";
  connection: Connection | null;
  runnerPath?: string;
  /** Opens the project's file search (from the new-tab page). */
  onFindFile?: () => void;
  findFileKeys?: string[];
  /** Open this address (a link clicked elsewhere); each new `n` opens it again. */
  open?: { url: string; n: number } | null;
  /** Make a port the runner found listening into a preview. */
  onOfferPort?: ((port: number) => void) | undefined;
}) {
  const previews = useMemo(() => {
    const last = [...events].reverse().find(e => e.type === "preview_update");
    return last?.type === "preview_update" ? last.previews : [];
  }, [events]);
  // Ports programs in the thread started listening on, that aren't previews yet.
  const found = useMemo(() => {
    const last = events.findLast(e => e.type === "listening_ports");
    const ports = last?.type === "listening_ports" ? last.ports : [];
    return ports.filter(p => !previews.some(x => x.port === p.port));
  }, [events, previews]);
  const [chosen, setChosen] = useState<View | null>(null);
  const [page, setPage] = useState<string | null>(null);
  // Until something is picked: the first preview, or a new tab while there is none.
  const view: View =
    chosen && (chosen.kind !== "preview" || previews.some(p => p.port === chosen.port))
      ? chosen
      : previews[0]
        ? { kind: "preview", port: previews[0].port }
        : { kind: "new" };
  const current: Preview | undefined = view.kind === "preview" ? previews.find(p => p.port === view.port) : undefined;

  const openPage = (url: string) => {
    setPage(url);
    setChosen({ kind: "page", url });
  };
  useEffect(() => {
    if (!open) return;
    // Elsewhere a local address means the sandbox's port: show it as that preview (once it's offered).
    const port = localPort(open.url);
    if (mode !== "local" && port) setChosen({ kind: "preview", port });
    else openPage(open.url);
    // openPage only sets state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const openFound = (port: number) => {
    onOfferPort?.(port);
    setChosen({ kind: "preview", port });
  };

  return (
    <div role="tabpanel" aria-label="Browser" className="flex min-h-0 flex-1 flex-col">
      {(previews.length > 0 || page || found.length > 0) && (
        <div className="flex min-h-11 items-center gap-1 border-b border-line px-2 py-1.5">
          <div className="flex min-w-0 flex-1 gap-1 overflow-x-auto [scrollbar-width:none]">
            {previews.map(p => (
              <Chip key={p.port} active={view.kind === "preview" && view.port === p.port} onClick={() => setChosen({ kind: "preview", port: p.port })}>
                {p.name}
                <span className="font-mono text-[12px] text-ink-faint">:{p.port}</span>
              </Chip>
            ))}
            {onOfferPort &&
              found.map(p => (
                <button
                  key={`found-${p.port}`}
                  type="button"
                  onClick={() => openFound(p.port)}
                  title={`${p.command} is listening on port ${p.port}`}
                  className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-lg border border-dashed border-line-strong px-2 text-[13px] text-ink-soft hover:bg-cream-deep hover:text-ink"
                >
                  <Radio aria-hidden="true" className="size-3.5" />
                  Open localhost:{p.port}
                </button>
              ))}
            {page && (
              <span className={cx("inline-flex h-7 shrink-0 items-center rounded-lg", view.kind === "page" ? "bg-cream-hover" : "")}>
                <button
                  type="button"
                  aria-pressed={view.kind === "page"}
                  onClick={() => setChosen({ kind: "page", url: page })}
                  className={cx(
                    "inline-flex h-7 max-w-[180px] items-center gap-1.5 rounded-lg pr-1 pl-2 text-[13px]",
                    view.kind === "page" ? "text-ink" : "text-ink-soft hover:bg-cream-deep",
                  )}
                >
                  <Globe aria-hidden="true" className="size-3.5 shrink-0" />
                  <span className="truncate">{shortAddress(page)}</span>
                </button>
                <button
                  type="button"
                  aria-label="Close this page"
                  onClick={() => {
                    setPage(null);
                    if (view.kind === "page") setChosen(null);
                  }}
                  className="mr-0.5 inline-flex size-5 items-center justify-center rounded-md text-ink-faint hover:bg-cream-deep hover:text-ink"
                >
                  <X aria-hidden="true" className="size-3" />
                </button>
              </span>
            )}
          </div>
          <Tip label="Open another address" side="bottom">
            <button
              type="button"
              aria-label="Open another address"
              onClick={() => setChosen({ kind: "new" })}
              className={cx(ICON_BUTTON, view.kind === "new" && "bg-cream-hover text-ink")}
            >
              <Plus aria-hidden="true" />
            </button>
          </Tip>
        </div>
      )}
      {view.kind === "new" ? (
        <NewTabPage
          heading={previews.length ? "Open another address" : "When the agent starts a dev server, it shows up here. Or open an address yourself."}
          onBrowser={openPage}
          onFindFile={onFindFile}
          findFileKeys={findFileKeys}
        />
      ) : view.kind === "page" ? (
        <BrowserView key={view.url} url={view.url} title={shortAddress(view.url)} onAddress={setPage} />
      ) : current ? (
        <PreviewFrame key={current.port} preview={current} mode={mode} connection={connection} {...(runnerPath ? { runnerPath } : {})} />
      ) : null}
    </div>
  );
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cx(
        "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-lg px-2 text-[13px] transition-colors duration-100",
        active ? "bg-cream-hover text-ink" : "text-ink-soft hover:bg-cream-deep",
      )}
    >
      <Globe aria-hidden="true" className="size-3.5" />
      {children}
    </button>
  );
}

/** One preview: opened straight on this computer, or through a tunnel for a cloud thread. */
function PreviewFrame({
  preview,
  mode,
  connection,
  runnerPath,
}: {
  preview: Preview;
  mode: "local" | "cloud";
  connection: Connection | null;
  runnerPath?: string;
}) {
  const [local, setLocal] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setError(null);
    setLocal(null);
    if (mode === "local") return setLocal(preview.port);
    if (!connection) return setError("The preview opens once the thread is running.");
    if (!inDesktopShell()) return setError("Cloud previews open in the LemonLime desktop app.");
    let cancelled = false;
    const url = connection.url;
    void connection
      .token()
      .then(t => startPreviewTunnel(url, preview.port, t, runnerPath))
      .then(p => !cancelled && setLocal(p))
      .catch(e => !cancelled && setError(e instanceof Error ? e.message : String(e)));
    const refresh = setInterval(() => void connection.token().then(t => previewTunnelToken(url, preview.port, t)), TOKEN_REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(refresh);
      void stopPreviewTunnel(url, preview.port);
    };
  }, [preview.port, mode, connection, runnerPath]);

  if (error) {
    return (
      <p role="alert" className="m-3 text-[14px] text-danger">
        {error}
      </p>
    );
  }
  if (!local) {
    return (
      <p role="status" className="m-3 text-[14px] text-ink-soft">
        Opening {preview.name}…
      </p>
    );
  }
  const origin = `http://127.0.0.1:${local}`;
  return (
    <BrowserView
      key={origin}
      url={`${origin}/`}
      title={preview.name}
      remember={mode === "local"}
      toAddress={typed => `${origin}${previewPath(typed)}`}
      fromAddress={url => (url.startsWith(origin) ? url.slice(origin.length) || "/" : url)}
      prefix={<span className="shrink-0 font-mono text-[12px] text-ink-faint">127.0.0.1:{local}</span>}
    />
  );
}
