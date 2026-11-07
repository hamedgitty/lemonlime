import { user, type Db } from "@lemonlime/db";
import { createLocalDb } from "@lemonlime/db/local";
import { defaultPlugin, type ResolvedPlugin, type UsagePolicy } from "@lemonlime/plugins";
import type { CreateSandboxOptions, RunnerLaunch, SandboxInfo, SandboxProvider } from "@lemonlime/sandbox";
import { createPersonalWorkspace } from "../src/lib/access.ts";
import { createAppContext, type AppContext } from "../src/lib/context.ts";
import type { EmailMessage, EmailSender } from "../src/lib/email.ts";
import { memoryHistoryStore } from "../src/lib/history.ts";

export const TEST_ENV = {
  LEMONLIME_PUBLIC_URL: "http://localhost:3000",
  LEMONLIME_TOKEN_SECRET: "test-master-secret-0123456789abcdef",
  LEMONLIME_CRON_SECRET: "test-cron-secret",
  BETTER_AUTH_SECRET: "test-better-auth-secret-0123456789abcdef",
};

/** An in-memory sandbox provider that records what it was asked to do. */
export class FakeSandboxProvider {
  readonly name = "fake";
  readonly calls: string[] = [];
  /** Every sandbox created, with how its runner was launched. */
  readonly created: CreateSandboxOptions[] = [];
  private n = 0;

  async create(opts: CreateSandboxOptions): Promise<SandboxInfo> {
    this.calls.push(`create:${opts.threadId}`);
    this.created.push(opts);
    return this.info(`sb-${++this.n}`);
  }
  async get(id: string): Promise<SandboxInfo | null> {
    return this.info(id);
  }
  async resume(id: string, _runner: RunnerLaunch): Promise<SandboxInfo> {
    this.calls.push(`resume:${id}`);
    return this.info(id);
  }
  async pause(id: string): Promise<void> {
    this.calls.push(`pause:${id}`);
  }
  async destroy(id: string): Promise<void> {
    this.calls.push(`destroy:${id}`);
  }
  private info(id: string): SandboxInfo {
    return { id, provider: this.name, state: "running", runnerUrl: `http://127.0.0.1:9000/${id}` };
  }
}

export interface TestApp {
  ctx: AppContext;
  db: Db;
  sandbox: FakeSandboxProvider;
  emails: EmailMessage[];
  history: ReturnType<typeof memoryHistoryStore>;
}

export async function createTestApp(opts: { policy?: Partial<UsagePolicy> } = {}): Promise<TestApp> {
  const { db } = await createLocalDb(":memory:");
  const sandbox = new FakeSandboxProvider();
  const emails: EmailMessage[] = [];
  const email: EmailSender = {
    name: "test",
    async send(m) {
      emails.push(m);
    },
  };
  const history = memoryHistoryStore();
  const plugin: ResolvedPlugin = { ...defaultPlugin, usagePolicy: { ...defaultPlugin.usagePolicy, ...opts.policy } };
  const ctx = createAppContext({
    runtime: "node",
    env: { ...TEST_ENV },
    db,
    production: false,
    plugin,
    email,
    sandbox: () => sandbox as unknown as SandboxProvider,
    history,
  });
  return { ctx, db, sandbox, emails, history };
}

/** Insert a user row directly (as Better Auth would) plus their personal workspace. */
export async function addUser(db: Db, email: string): Promise<{ userId: string; workspaceId: string }> {
  const userId = `user-${crypto.randomUUID()}`;
  await db.insert(user).values({ id: userId, name: "", email, emailVerified: true, updatedAt: new Date() });
  const workspaceId = await createPersonalWorkspace(db, userId, email);
  return { userId, workspaceId };
}
