import { allowAllPolicy, type UsagePolicy } from "./usage-policy.ts";
import { emptyBillingUI, type BillingUI } from "./billing-ui.ts";

export * from "./usage-policy.ts";
export * from "./billing-ui.ts";

/** A deployment's hooks. */
export interface LemonLimePlugin {
  name: string;
  usagePolicy?: UsagePolicy;
  billingUI?: BillingUI;
}

/**
 * What the plugin sees at runtime. `env` holds the deployment's environment:
 * string variables and, on platforms like Cloudflare Workers, bindings such as
 * databases. Plugins read their own configuration from here instead of globals,
 * so they work the same on Node and on Workers.
 */
export interface PluginContext {
  env: Record<string, unknown>;
}

/** A plugin module's default export: a plugin, or a factory that builds one from the runtime context. */
export type PluginExport = LemonLimePlugin | ((ctx: PluginContext) => LemonLimePlugin);

/** A plugin with every hook filled in. */
export interface ResolvedPlugin {
  name: string;
  usagePolicy: UsagePolicy;
  billingUI: BillingUI;
}

export function definePlugin<T extends PluginExport>(plugin: T): T {
  return plugin;
}

export const defaultPlugin: ResolvedPlugin = {
  name: "default",
  usagePolicy: allowAllPolicy,
  billingUI: emptyBillingUI,
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
