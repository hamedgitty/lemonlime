#!/usr/bin/env node
// Runs the TypeScript source directly via tsx, so the package works from a checkout.
import { register } from "tsx/esm/api";

register();
const { main } = await import("../src/cli.ts");
main().catch(err => {
  process.stderr.write(`lemonlime-runner: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
