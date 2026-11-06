import { allowAllPolicy, type UsagePolicy } from "./usage-policy.ts";
import { emptyBillingUI, type BillingUI } from "./billing-ui.ts";

export * from "./usage-policy.ts";
export * from "./billing-ui.ts";

/** What a plugin module exports (as its default export). */
export interface LemonLimePlugin {
  name: string;
  usagePolicy?: UsagePolicy;
  billingUI?: BillingUI;
}

/** A plugin with every hook filled in. */
export interface ResolvedPlugin {
  name: string;
  usagePolicy: UsagePolicy;
  billingUI: BillingUI;
}

export function definePlugin(plugin: LemonLimePlugin): LemonLimePlugin {
  return plugin;
}

export const defaultPlugin: ResolvedPlugin = {
  name: "default",
  usagePolicy: allowAllPolicy,
  billingUI: emptyBillingUI,
};

/** Fill any missing hooks with the free defaults. */
export function resolvePlugin(plugin?: LemonLimePlugin | null): ResolvedPlugin {
  if (!plugin) return defaultPlugin;
  return {
    name: plugin.name,
    usagePolicy: plugin.usagePolicy ?? allowAllPolicy,
    billingUI: plugin.billingUI ?? emptyBillingUI,
  };
}

/**
 * Load a plugin by module specifier (e.g. the LEMONLIME_PLUGIN env var).
 * An empty specifier returns the defaults. A specifier that fails to load throws,
 * so a misconfigured deployment never silently runs without its policy.
 */
export async function loadPlugin(
  specifier: string | undefined,
  importer: (s: string) => Promise<unknown> = s => import(/* @vite-ignore */ s),
): Promise<ResolvedPlugin> {
  if (!specifier || !specifier.trim()) return defaultPlugin;
  const mod = (await importer(specifier.trim())) as { default?: LemonLimePlugin } & Partial<LemonLimePlugin>;
  const plugin = mod.default ?? (mod.name ? (mod as LemonLimePlugin) : undefined);
  if (!plugin) throw new Error(`Plugin "${specifier}" has no default export`);
  return resolvePlugin(plugin);
}
