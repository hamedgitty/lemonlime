import type { AgentKind, ThreadMode } from "@lemonlime/protocol";
import { allowAllPolicy, type UsagePolicy } from "./usage-policy.ts";
import { emptyBillingUI, type BillingUI } from "./billing-ui.ts";
import type { EmailBrand } from "./email.ts";

export * from "./usage-policy.ts";
export * from "./billing-ui.ts";
export * from "./email.ts";

/** Things that happen in the control plane a deployment may want to act on. */
export interface PluginEvents {
  /** A person signed in for the first time and got their personal workspace. */
  onUserCreated?(user: { userId: string; email: string | null; workspaceId: string }): Promise<void>;
  /** A thread was created (for cloud threads: once its sandbox started). */
  onThreadCreated?(thread: { threadId: string; workspaceId: string; userId: string; mode: ThreadMode; agent: AgentKind }): Promise<void>;
  /**
   * Called about once a minute by the control plane's sweep (the Workers cron trigger, or
   * POST /api/cron/sweep on Node), for periodic work such as reminder emails. Keep it quick:
   * a slow hook delays the next sweep.
   */
  onSchedule?(now: number): Promise<void>;
  /**
   * A workspace is about to be deleted (by its owner, or with its owner's account). Its
   * sandboxes are already gone; its rows go once this returns. Throwing stops the deletion,
   * so use it for what must not be left behind, such as ending a paid subscription.
   */
  onWorkspaceDeleted?(workspace: { workspaceId: string; deletedBy: string }): Promise<void>;
  /** An account is about to be deleted, after its workspaces. Throwing stops the deletion. */
  onUserDeleted?(user: { userId: string; email: string | null }): Promise<void>;
  /**
   * Anything more the deployment keeps about this person, for their data export (for
   * example billing records). Returned under `deployment` in the export file.
   */
  exportUserData?(user: { userId: string; email: string | null; workspaceIds: string[] }): Promise<Record<string, unknown>>;
}

/** A deployment's hooks. */
export interface LemonLimePlugin {
  name: string;
  usagePolicy?: UsagePolicy;
  billingUI?: BillingUI;
  events?: PluginEvents;
}

/** An email a plugin can send through the control plane's own email setup. */
export interface PluginEmail {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

/** What the control plane offers plugins at runtime. */
export interface PluginServices {
  sendEmail(message: PluginEmail): Promise<void>;
  /** This deployment's name, logo and links, for `renderEmail`, so plugin emails match the app's own. */
  emailBrand(): EmailBrand;
  /** A user's email address, or null. */
  userEmail(userId: string): Promise<string | null>;
  /** The email addresses of a workspace's owners, for notices about the workspace itself. */
  workspaceOwnerEmails(workspaceId: string): Promise<string[]>;
}

/**
 * What the plugin sees at runtime. `env` holds the deployment's environment:
 * string variables and, on platforms like Cloudflare Workers, bindings such as
 * databases. Plugins read their own configuration from here instead of globals,
 * so they work the same on Node and on Workers.
 */
export interface PluginContext {
  env: Record<string, unknown>;
  /** Email and user lookups. Absent in contexts that can't provide them (e.g. some tests). */
  services?: PluginServices;
}

/** A plugin module's default export: a plugin, or a factory that builds one from the runtime context. */
export type PluginExport = LemonLimePlugin | ((ctx: PluginContext) => LemonLimePlugin);

/** A plugin with every hook filled in. */
export interface ResolvedPlugin {
  name: string;
  usagePolicy: UsagePolicy;
  billingUI: BillingUI;
  events: PluginEvents;
}

export function definePlugin<T extends PluginExport>(plugin: T): T {
  return plugin;
}

export const defaultPlugin: ResolvedPlugin = {
  name: "default",
  usagePolicy: allowAllPolicy,
  billingUI: emptyBillingUI,
  events: {},
};

/** Build the plugin (calling the factory if needed) and fill missing hooks with the free defaults. */
export function resolvePlugin(plugin: PluginExport | null | undefined, ctx: PluginContext = { env: {} }): ResolvedPlugin {
  if (!plugin) return defaultPlugin;
  const p = typeof plugin === "function" ? plugin(ctx) : plugin;
  if (!p) return defaultPlugin;
  return {
    name: p.name,
    usagePolicy: p.usagePolicy ?? allowAllPolicy,
    billingUI: p.billingUI ?? emptyBillingUI,
    events: p.events ?? {},
  };
}

/**
 * Load a plugin by module specifier at runtime (Node deployments only; bundled
 * platforms such as Workers use the `@lemonlime/deployment-plugin` module instead).
 * An empty specifier returns the defaults. A specifier that fails to load throws,
 * so a misconfigured deployment never silently runs without its policy.
 */
export async function loadPlugin(
  specifier: string | undefined,
  importer: (s: string) => Promise<unknown> = s => import(/* @vite-ignore */ s),
  ctx: PluginContext = { env: {} },
): Promise<ResolvedPlugin> {
  if (!specifier || !specifier.trim()) return defaultPlugin;
  const mod = (await importer(specifier.trim())) as { default?: PluginExport } & Partial<LemonLimePlugin>;
  const plugin = mod.default ?? (mod.name ? (mod as LemonLimePlugin) : undefined);
  if (!plugin) throw new Error(`Plugin "${specifier}" has no default export`);
  return resolvePlugin(plugin, ctx);
}
