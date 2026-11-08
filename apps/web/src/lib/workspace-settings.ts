import { eq } from "drizzle-orm";
import { workspaceSettings, type WorkspaceSettingsRow } from "@lemonlime/db";
import { DEFAULT_WORKSPACE_SETTINGS, skillsBytes, type PutWorkspaceSettingsRequest, type UserSkill, type WorkspaceSettingsResponse } from "@lemonlime/protocol";
import { requireWorkspaceMember } from "./access.ts";
import type { AppContext } from "./context.ts";
import { memberRole, requireOwner } from "./members.ts";

/**
 * Workspace-level settings for cloud threads (instructions, setup script, co-author
 * trailers, automatic retry, auto-delete, the workspace's own skills). Every member can
 * read them; only owners change them. They apply to sandboxes started after the change.
 */

/** The stored settings, or the defaults for a workspace that never saved any. */
export async function loadWorkspaceSettings(ctx: AppContext, workspaceId: string): Promise<Omit<WorkspaceSettingsRow, "updatedBy">> {
  const row = await ctx.db.select().from(workspaceSettings).where(eq(workspaceSettings.workspaceId, workspaceId)).get();
  return row ?? { workspaceId, ...DEFAULT_WORKSPACE_SETTINGS, skills: [], updatedAt: "" };
}

function toResponse(row: Omit<WorkspaceSettingsRow, "updatedBy">, canEdit: boolean): WorkspaceSettingsResponse {
  return {
    workspaceId: row.workspaceId,
    canEdit,
    settings: {
      instructions: row.instructions,
      setupScript: row.setupScript,
      stripCoauthors: row.stripCoauthors,
      retryMaxWaitMinutes: row.retryMaxWaitMinutes,
      autoDeleteDays: row.autoDeleteDays,
      skills: row.skills.map(s => ({ name: s.name, fileCount: Object.keys(s.files).length, bytes: skillsBytes([s]) })),
      updatedAt: row.updatedAt || null,
    },
  };
}

/** Any member may look. */
export async function getWorkspaceSettings(ctx: AppContext, userId: string, workspaceId: string): Promise<WorkspaceSettingsResponse> {
  await requireWorkspaceMember(ctx.db, userId, workspaceId);
  const canEdit = (await memberRole(ctx.db, userId, workspaceId)) === "owner";
  return toResponse(await loadWorkspaceSettings(ctx, workspaceId), canEdit);
}

async function save(
  ctx: AppContext,
  userId: string,
  workspaceId: string,
  patch: Partial<Omit<WorkspaceSettingsRow, "workspaceId" | "updatedAt" | "updatedBy">>,
) {
  const now = new Date().toISOString();
  const current = await loadWorkspaceSettings(ctx, workspaceId);
  const { workspaceId: _w, updatedAt: _u, ...fields } = current;
  const next = { ...fields, ...patch, updatedBy: userId, updatedAt: now };
  const [row] = await ctx.db
    .insert(workspaceSettings)
    .values({ workspaceId, ...next })
    .onConflictDoUpdate({ target: workspaceSettings.workspaceId, set: next })
    .returning();
  return row!;
}

/** Owners only. Fields left out stay as they are. */
export async function updateWorkspaceSettings(
  ctx: AppContext,
  userId: string,
  workspaceId: string,
  patch: PutWorkspaceSettingsRequest,
): Promise<WorkspaceSettingsResponse> {
  await requireOwner(ctx.db, userId, workspaceId);
  const fields = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) as PutWorkspaceSettingsRequest;
  return toResponse(await save(ctx, userId, workspaceId, fields), true);
}

/** The workspace's skills with their files. Any member may look. */
export async function getWorkspaceSkills(ctx: AppContext, userId: string, workspaceId: string): Promise<UserSkill[]> {
  await requireWorkspaceMember(ctx.db, userId, workspaceId);
  return (await loadWorkspaceSettings(ctx, workspaceId)).skills;
}

/** Owners only: replace the whole list (the desktop app syncs the user's skills this way). */
export async function putWorkspaceSkills(ctx: AppContext, userId: string, workspaceId: string, skills: UserSkill[]): Promise<WorkspaceSettingsResponse> {
  await requireOwner(ctx.db, userId, workspaceId);
  return toResponse(await save(ctx, userId, workspaceId, { skills }), true);
}

// ─── Into a new sandbox ──────────────────────────────────────────────────────

/** Most of one environment variable holding skills; Linux refuses single values over 128 KB. */
const SKILL_CHUNK_CHARS = 96 * 1024;

async function gzipBase64(text: string): Promise<string> {
  const stream = new Blob([new TextEncoder().encode(text)]).stream().pipeThrough(new CompressionStream("gzip"));
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/**
 * What a new sandbox's runner gets from the workspace's settings: environment variables
 * (see the runner's --help) and the setup script for the sandbox provider to run first.
 */
export async function sandboxSettings(
  ctx: AppContext,
  workspaceId: string,
): Promise<{ env: Record<string, string>; retryMaxWaitMinutes: number; setupScript: string | null }> {
  const s = await loadWorkspaceSettings(ctx, workspaceId);
  const env: Record<string, string> = {};
  if (s.instructions.trim()) env.LEMONLIME_INSTRUCTIONS = s.instructions;
  if (s.stripCoauthors) env.LEMONLIME_STRIP_COAUTHORS = "1";
  if (s.skills.length) {
    const packed = await gzipBase64(JSON.stringify(s.skills));
    for (let i = 0; i * SKILL_CHUNK_CHARS < packed.length; i++)
      env[`LEMONLIME_USER_SKILLS_${i}`] = packed.slice(i * SKILL_CHUNK_CHARS, (i + 1) * SKILL_CHUNK_CHARS);
  }
  return { env, retryMaxWaitMinutes: s.retryMaxWaitMinutes, setupScript: s.setupScript.trim() ? s.setupScript : null };
}
