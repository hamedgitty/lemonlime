import type { NextConfig } from "next";

/**
 * The workspace packages ship raw TypeScript (`exports: "./src/index.ts"`, with
 * `.ts` extensions in their imports), so Next compiles them like app code.
 *
 * `@lemonlime/deployment-plugin` is the deployment's plugin, bundled at build
 * time. A deployment that wants its own hooks replaces that package (for
 * example with a pnpm override); see docs/self-hosting.md.
 */
const workspacePackages = [
  "@lemonlime/protocol",
  "@lemonlime/plugins",
  "@lemonlime/deployment-plugin",
  "@lemonlime/sandbox",
  "@lemonlime/client",
  "@lemonlime/db",
];

const nextConfig: NextConfig = {
  transpilePackages: workspacePackages,
  // Sandbox SDKs and the local SQLite driver use native and dynamic requires;
  // on Node, load them from node_modules at runtime.
  serverExternalPackages: ["@daytonaio/sdk", "e2b", "@libsql/client", "libsql"],
  turbopack: {
    resolveExtensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".json"],
  },
  webpack(config) {
    // Only used with `next build --webpack`: let `.js` specifiers find `.ts` sources too.
    config.resolve ??= {};
    config.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js"],
      ".mjs": [".mts", ".mjs"],
    };
    return config;
  },
};

export default nextConfig;
