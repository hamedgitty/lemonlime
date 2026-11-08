import { DockerProvider } from "./docker.ts";
import { DaytonaProvider } from "./daytona.ts";
import { E2BProvider } from "./e2b.ts";
import type { SandboxProvider } from "./types.ts";

export * from "./types.ts";
export { containerName, DockerProvider, mapDockerState } from "./docker.ts";
export { DaytonaProvider, mapDaytonaState } from "./daytona.ts";
export { E2BProvider, mapE2BState } from "./e2b.ts";
export { ProviderHttpError } from "./http.ts";
export type { DockerProviderOptions } from "./docker.ts";
export type { DaytonaProviderOptions } from "./daytona.ts";
export type { E2BProviderOptions } from "./e2b.ts";

/**
 * Build the provider named in config. Throws on missing settings so misconfiguration fails fast.
 * Pass the environment explicitly (`process.env` on Node, the `env` binding on Workers).
 */
export function createSandboxProvider(env: Record<string, string | undefined>): SandboxProvider {
  const name = (env.LEMONLIME_SANDBOX_PROVIDER ?? "docker").toLowerCase();
  const image = env.LEMONLIME_SANDBOX_IMAGE ?? "lemonlime/sandbox:latest";
  const need = (key: string): string => {
    const v = env[key];
    if (!v) throw new Error(`${key} is required for the ${name} sandbox provider`);
    return v;
  };
  switch (name) {
    case "docker":
      return new DockerProvider({
        image,
        bindHost: env.LEMONLIME_DOCKER_BIND_HOST || undefined,
        network: env.LEMONLIME_DOCKER_NETWORK || undefined,
        publicUrl: env.LEMONLIME_DOCKER_PUBLIC_URL || undefined,
        agentUser: env.LEMONLIME_DOCKER_AGENT_USER || undefined,
      });
    case "daytona":
      return new DaytonaProvider({
        apiKey: need("DAYTONA_API_KEY"),
        apiUrl: env.DAYTONA_API_URL,
        image,
        snapshot: env.DAYTONA_SNAPSHOT || undefined,
        snapshots: { small: env.DAYTONA_SNAPSHOT_SMALL || undefined, large: env.DAYTONA_SNAPSHOT_LARGE || undefined },
      });
    case "e2b":
      return new E2BProvider({
        apiKey: need("E2B_API_KEY"),
        templates: { small: env.E2B_TEMPLATE_SMALL ?? image, large: env.E2B_TEMPLATE_LARGE ?? image },
      });
    default:
      throw new Error(`Unknown sandbox provider "${name}". Use docker, daytona or e2b.`);
  }
}
