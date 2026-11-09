import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { runnerHttpBase } from "@lemonlime/client";
import { CommandsResponse, FilesResponse, type AgentCommand, type AgentKind } from "@lemonlime/protocol";
import { listPlugins } from "./plugins.ts";
import type { Connection } from "./useThreadSession.ts";

/**
 * Where the composer's `/` and `@` menus get their entries: the thread's runner (the
 * agent's commands, files in its repository), plus the slash commands of enabled plugins.
 */

export interface ComposerSources {
  commands: AgentCommand[];
  /** Ask again (the agent may have reported more since). */
  refreshCommands: () => void;
  /** Best matching files for `query`; empty when not connected. */
  searchFiles: (query: string, signal?: AbortSignal) => Promise<string[]>;
}

/** GET a JSON answer from the thread's runner. */
export async function getJson(conn: Connection, path: string, signal?: AbortSignal): Promise<unknown> {
  const res = await fetch(`${runnerHttpBase(conn.url)}${path}`, {
    headers: { authorization: `Bearer ${await conn.token()}` },
    ...(signal ? { signal } : {}),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** Plugin commands as Claude Code names them once installed in a thread: `plugin:command`. */
export function pluginCommands(plugins: { name: string; enabled: boolean; description: string; contents: { commands: string[] } }[]): AgentCommand[] {
  return plugins
    .filter(p => p.enabled)
    .flatMap(p => p.contents.commands.map(c => ({ name: `${p.name}:${c.replace(/\//g, ":")}`, description: "", source: "plugin" as const })));
}

/** One list, each name once: the runner's entries win over plugin ones. */
export function mergeCommands(...lists: readonly AgentCommand[][]): AgentCommand[] {
  const out = new Map<string, AgentCommand>();
  for (const list of lists) for (const c of list) if (!out.has(c.name)) out.set(c.name, c);
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function useComposerSources(connection: Connection | null, agent: AgentKind): ComposerSources {
  const [fromRunner, setFromRunner] = useState<AgentCommand[]>([]);
  const [fromPlugins, setFromPlugins] = useState<AgentCommand[]>([]);
  const connRef = useRef(connection);
  connRef.current = connection;
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!connection) return;
    const ctl = new AbortController();
    getJson(connection, "/commands", ctl.signal)
      .then(raw => {
        const r = CommandsResponse.safeParse(raw);
        if (r.success) setFromRunner(r.data.commands);
      })
      .catch(() => undefined);
    return () => ctl.abort();
  }, [connection, tick]);

  // Plugin commands only reach Claude Code (other agents don't read command files).
  useEffect(() => {
    if (agent !== "claude-code") return;
    let live = true;
    void listPlugins()
      .then(list => live && setFromPlugins(pluginCommands(list)))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [agent]);

  const searchFiles = useCallback(async (query: string, signal?: AbortSignal) => {
    const conn = connRef.current;
    if (!conn) return [];
    const raw = await getJson(conn, `/files?q=${encodeURIComponent(query)}&limit=50`, signal);
    const r = FilesResponse.safeParse(raw);
    return r.success ? r.data.files : [];
  }, []);

  const refreshCommands = useCallback(() => setTick(t => t + 1), []);
  const commands = useMemo(() => mergeCommands(fromRunner, fromPlugins), [fromRunner, fromPlugins]);
  return { commands, refreshCommands, searchFiles };
}
