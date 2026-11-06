import type { NextConfig } from "next";

/**
 * The workspace packages ship raw TypeScript (`exports: "./src/index.ts"`, with
 * `.ts` extensions in their imports), so Next compiles them like app code.
 */
const workspacePackages = ["@lemonlime/protocol", "@lemonlime/plugins", "@lemonlime/sandbox", "@lemonlime/client"];

const nextConfig: NextConfig = {
  transpilePackages: workspacePackages,
  // Sandbox SDKs use native and dynamic requires; load them from node_modules at runtime.
  serverExternalPackages: ["@daytonaio/sdk", "e2b"],
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
