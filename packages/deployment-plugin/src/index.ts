import type { PluginExport } from "@lemonlime/plugins";

/**
 * Bundled platforms (like Cloudflare Workers) can't load a plugin by name at
 * runtime, so the app imports this module instead. This default has no plugin,
 * which means every hook uses its free default: allow everything, render nothing.
 *
 * To ship your own hooks, replace this package at build time, for example with a
 * pnpm override: "@lemonlime/deployment-plugin": "link:../my-plugin".
 * Your module's default export must be a PluginExport.
 */
const plugin: PluginExport | null = null;
export default plugin;
