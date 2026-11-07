// Entry point of the single-file runner the desktop app ships (see scripts/build-sea.mjs).
import { main } from "./cli.ts";

main().catch(err => {
  process.stderr.write(`lemonlime-runner: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
