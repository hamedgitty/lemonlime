import { joinCommand } from "./command.ts";
import { findMachine } from "./machines.ts";
import { removeLocalThread, removeSshThread, startLocalRunner, startSshRunner, stopLocalRunner, type LocalRunnerInfo } from "./native.ts";
import type { LocalThreadMeta } from "./storage.ts";

/**
 * Starting and removing the runner of a thread the app runs itself: on this computer, or
 * on one of the user's machines over SSH (then reached through a tunnel on 127.0.0.1, so
 * the rest of the app treats both the same).
 */

/** The machine's name for a thread on another machine; null for a thread on this computer. */
export function machineName(meta: Pick<LocalThreadMeta, "machine">): string | null {
  if (!meta.machine) return null;
  return findMachine(meta.machine)?.name ?? "a removed machine";
}

export async function startThreadRunner(meta: LocalThreadMeta, runnerPath: string): Promise<LocalRunnerInfo> {
  const args = {
    threadId: meta.id,
    agent: meta.agent.kind,
    agentCommand: meta.agent.command ? joinCommand(meta.agent.command) : undefined,
    model: meta.agent.model,
    reasoning: meta.agent.reasoning,
    fast: meta.agent.fast,
    workdir: meta.repoPath,
    baseBranch: meta.baseBranch,
  };
  if (!meta.machine) return startLocalRunner({ ...args, runnerPath });
  const machine = findMachine(meta.machine);
  if (!machine) throw new Error("This thread's machine was removed from Settings, Machines. Add it again to open the thread.");
  return startSshRunner({ ...args, host: machine.host, remoteRunnerPath: machine.runnerPath });
}

/** Stops the thread and removes its worktree and history where it ran; the branch stays. */
export async function removeThreadRunner(meta: LocalThreadMeta, runnerPath: string): Promise<void> {
  if (!meta.machine) return removeLocalThread(meta.id, meta.repoPath, runnerPath);
  const machine = findMachine(meta.machine);
  if (!machine) return stopLocalRunner(meta.id);
  return removeSshThread(meta.id, machine.host, machine.runnerPath, meta.repoPath);
}
