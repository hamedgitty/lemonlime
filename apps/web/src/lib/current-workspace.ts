import { cookies } from "next/headers";
import type { Db } from "@lemonlime/db";
import { isWorkspaceMember, resolveWorkspace, userWorkspaceIds } from "./access.ts";

/**
 * Which workspace the dashboard is showing. People in more than one workspace (their
 * personal one and a team's) pick one; the choice is kept in a cookie. A choice that no
 * longer works (they left, or were removed) quietly falls back to the default.
 */
export const WORKSPACE_COOKIE = "lemonlime_workspace";

async function chosenOrDefault(db: Db, userId: string, chosen: string | null | undefined): Promise<string> {
  if (chosen && (await isWorkspaceMember(db, userId, chosen))) return chosen;
  return (await userWorkspaceIds(db, userId))[0]!;
}

function cookieValue(header: string | null, name: string): string | null {
  for (const part of header?.split(";") ?? []) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

/** For API routes: `?workspace=` when given (403 if not a member), else the saved choice. */
export async function requestWorkspace(db: Db, userId: string, request: Request): Promise<string> {
  const asked = new URL(request.url).searchParams.get("workspace");
  if (asked) return resolveWorkspace(db, userId, asked);
  return chosenOrDefault(db, userId, cookieValue(request.headers.get("cookie"), WORKSPACE_COOKIE));
}

/** For pages and layouts. */
export async function pageWorkspace(db: Db, userId: string): Promise<string> {
  return chosenOrDefault(db, userId, (await cookies()).get(WORKSPACE_COOKIE)?.value);
}

/** The Set-Cookie options for remembering a choice for a year. */
export function workspaceCookieOptions(secure: boolean) {
  return { httpOnly: true, sameSite: "lax" as const, secure, path: "/", maxAge: 365 * 86_400 };
}
