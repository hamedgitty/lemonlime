import { createSandboxProvider, type SandboxProvider } from "@lemonlime/sandbox";

let provider: SandboxProvider | null = null;

/** The configured sandbox provider (LEMONLIME_SANDBOX_PROVIDER), created once per server process. */
export function getSandboxProvider(): SandboxProvider {
  provider ??= createSandboxProvider(process.env);
  return provider;
}
