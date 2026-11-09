import type { ReactNode } from "react";
import type { PolicyDecision } from "./usage-policy.ts";

/**
 * UI slots a deployment can fill. Every slot is optional; an empty slot renders nothing.
 * Slots are plain functions returning React nodes so they work in server and client components.
 */
export interface BillingUI {
  /**
   * Extra section on the account/settings page. `isOwner`: the viewer owns this workspace;
   * keep billing details and changes to owners.
   */
  accountSection?: (props: { workspaceId: string; isOwner: boolean }) => ReactNode;
  /** Small badge in the app header, e.g. remaining usage. */
  headerBadge?: (props: { workspaceId: string }) => ReactNode;
  /** Shown when a UsagePolicy denies an action. Defaults to the plain reason text. */
  deniedNotice?: (props: { decision: Extract<PolicyDecision, { allow: false }> }) => ReactNode;
}

/** Default: renders nothing. */
export const emptyBillingUI: BillingUI = {};

/** Render a slot if present, otherwise nothing. */
export function renderSlot<P>(slot: ((props: P) => ReactNode) | undefined, props: P): ReactNode {
  return slot ? slot(props) : null;
}
