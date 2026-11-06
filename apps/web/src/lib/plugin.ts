import { loadPlugin, type ResolvedPlugin } from "@lemonlime/plugins";

let cached: Promise<ResolvedPlugin> | null = null;

/**
 * The deployment's plugin (LEMONLIME_PLUGIN), loaded once per server process.
 * Empty → the defaults, which allow everything and render nothing.
 * The import bypasses the bundler so any installed module or absolute path works.
 */
export function getPlugin(): Promise<ResolvedPlugin> {
  cached ??= loadPlugin(process.env.LEMONLIME_PLUGIN, specifier =>
    import(/* webpackIgnore: true */ /* turbopackIgnore: true */ specifier),
  ).catch(err => {
    cached = null; // retry on the next request instead of caching the failure
    throw err;
  });
  return cached;
}
