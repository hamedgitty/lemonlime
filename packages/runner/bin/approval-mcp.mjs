#!/usr/bin/env node
// Runs the approval helper from source (see src/approval-mcp.ts). The shipped runner runs
// the same code as `lemonlime-runner approval-mcp`.
import { register } from "tsx/esm/api";

register();
const { runApprovalMcp } = await import("../src/approval-mcp.ts");
runApprovalMcp();
