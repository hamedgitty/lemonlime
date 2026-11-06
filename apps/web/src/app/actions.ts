"use server";

import type { ReactNode } from "react";
import { PolicyDenied } from "@lemonlime/protocol";
import { renderSlot } from "@lemonlime/plugins";
import { getUser } from "@/lib/auth.ts";
import { getAppContext } from "@/lib/env.ts";

/**
 * Render the deployment's `billingUI.deniedNotice` for a 402 response.
 * Returns null when the plugin has no notice, so the caller shows the plain reason.
 */
export async function renderDeniedNotice(body: PolicyDenied): Promise<ReactNode> {
  const parsed = PolicyDenied.safeParse(body);
  if (!parsed.success) return null;
  const ctx = await getAppContext();
  if (!(await getUser(ctx))) return null;
  const { billingUI } = ctx.plugin;
  const { reason, actionUrl, actionLabel } = parsed.data;
  return renderSlot(billingUI.deniedNotice, {
    decision: { allow: false, reason, ...(actionUrl ? { actionUrl } : {}), ...(actionLabel ? { actionLabel } : {}) },
  });
}
