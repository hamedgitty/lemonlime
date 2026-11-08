// Stands in for an agent CLI: writes the arguments and git settings it was started with to
// $ARGS_OUT, then exits successfully without printing anything.
import { writeFileSync } from "node:fs";

writeFileSync(process.env.ARGS_OUT, JSON.stringify({ args: process.argv.slice(2), gitConfig: process.env.GIT_CONFIG_PARAMETERS ?? null }));
