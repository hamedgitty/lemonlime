/**
 * Check a sandbox provider for real, with the provider settings in the environment:
 *
 *   LEMONLIME_SANDBOX_PROVIDER=daytona DAYTONA_API_KEY=… LEMONLIME_SANDBOX_IMAGE=… \
 *     pnpm --filter @lemonlime/sandbox live-check
 *
 * Creates a small sandbox from the image, waits for the runner's /healthz, pauses it,
 * resumes it, checks /healthz again and destroys it. The sandbox is destroyed even when
 * a step fails or the check is stopped. It starts the runner with no repository or control plane, so nothing
 * outside the sandbox is touched; it costs a minute or two of the provider's time.
 */
import { randomBytes } from "node:crypto";
import { createSandboxProvider, type RunnerLaunch, type SandboxInfo } from "../src/index.ts";

const provider = createSandboxProvider(process.env);
const threadId = `live-check-${randomBytes(4).toString("hex")}`;
const runner: RunnerLaunch = {
  command: `lemonlime-runner --thread ${threadId} --agent claude-code --host 0.0.0.0 --port 7420`,
  port: 7420,
  env: { LEMONLIME_THREAD_SECRET: randomBytes(32).toString("hex") },
};

const started = Date.now();
const step = (what: string) => console.log(`${((Date.now() - started) / 1000).toFixed(1).padStart(6)}s  ${what}`);

async function healthy(info: SandboxInfo): Promise<void> {
  if (!info.runnerUrl) throw new Error(`no runner URL (state ${info.state})`);
  const url = new URL("/healthz", info.runnerUrl).toString();
  for (let i = 0; i < 60; i++) {
    const res = await fetch(url).catch(() => null);
    if (res?.ok) return step(`/healthz answered ${res.status}`);
    await new Promise(r => setTimeout(r, 2000));
  }
  throw new Error(`${url} never answered`);
}

let id: string | null = null;
let creating: Promise<SandboxInfo> | null = null;
let destroyed: Promise<void> | null = null;

/** Destroy the sandbox, once, however the check ends. */
function destroy(): Promise<void> {
  const sandbox = id;
  if (!sandbox) return Promise.resolve();
  destroyed ??= provider
    .destroy(sandbox)
    .then(async () => step(`destroyed ${sandbox}, now ${(await provider.get(sandbox).catch(() => null))?.state ?? "gone"}`))
    .catch(err => console.error(`Couldn't destroy ${sandbox}; delete it by hand: ${err}`));
  return destroyed;
}

// Stopping the check (Ctrl-C, a CI timeout) must not leave a sandbox running. One that is
// still being created is waited for, so there is an id to destroy.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    console.error(`\nStopped by ${signal}.`);
    void (creating ?? Promise.resolve(null))
      .then(
        created => {
          id ??= created?.id ?? null;
        },
        () => undefined,
      )
      .then(destroy)
      .finally(() => process.exit(1));
  });
}

try {
  step(`creating a small ${provider.name} sandbox for ${threadId}`);
  creating = provider.create({ threadId, size: "small", runner, labels: { "lemonlime.live-check": "1" } });
  const created = await creating;
  id = created.id;
  step(`created ${id}, state ${created.state}`);
  await healthy(created);
  await provider.pause(id);
  step(`paused, state ${(await provider.get(id))?.state}`);
  const resumed = await provider.resume(id, runner);
  step(`resumed, state ${resumed.state}`);
  await healthy(resumed);
  console.log("\nAll steps passed.");
} catch (err) {
  console.error(`\nFailed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  await destroy();
}
