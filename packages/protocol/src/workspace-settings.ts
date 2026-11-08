import { z } from "zod";

/**
 * Workspace-level settings for cloud threads: what every new sandbox in the workspace
 * starts with. Read by every member, changed by owners (GET/PUT /api/workspace/settings,
 * PUT /api/workspace/skills).
 */

/** Custom instructions added to every agent turn (the runner caps them at the same size). */
export const INSTRUCTIONS_MAX_BYTES = 32 * 1024;
/** A shell script run once in each new sandbox before the runner starts. */
export const SETUP_SCRIPT_MAX_BYTES = 16 * 1024;
/** All of a workspace's own skills together (every file's path and content). */
export const USER_SKILLS_MAX_BYTES = 1024 * 1024;
/** Longest automatic-retry wait that can be set, in minutes (a week). */
export const RETRY_MAX_WAIT_MINUTES_LIMIT = 7 * 24 * 60;
/** Most files in one skill. */
export const SKILL_MAX_FILES = 200;

export const utf8Bytes = (s: string): number => new TextEncoder().encode(s).length;

/** A skill folder name: also the folder the runner copies it into. */
export const SkillName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, "skill names use letters, digits, . _ and -");

/** A path inside a skill folder: relative, "/"-separated, nothing hidden or outside it. */
export const SkillFilePath = z
  .string()
  .min(1)
  .max(200)
  .refine(
    p => !p.startsWith("/") && !p.includes("\\") && !p.includes("\0") && p.split("/").every(part => part !== "" && part !== "." && part !== ".."),
    "skill file paths are relative, with no empty, . or .. parts",
  );

/** One of the user's own skills: a SKILL.md and any files next to it, as text. */
export const UserSkill = z
  .object({
    name: SkillName,
    files: z.record(SkillFilePath, z.string()),
  })
  .refine(s => "SKILL.md" in s.files, { message: "every skill needs a SKILL.md", path: ["files"] })
  .refine(s => Object.keys(s.files).length <= SKILL_MAX_FILES, { message: `a skill can have at most ${SKILL_MAX_FILES} files`, path: ["files"] });
export type UserSkill = z.infer<typeof UserSkill>;

/** Size of a skill list as it counts towards USER_SKILLS_MAX_BYTES. */
export function skillsBytes(skills: readonly UserSkill[]): number {
  let n = 0;
  for (const s of skills) for (const [path, content] of Object.entries(s.files)) n += utf8Bytes(path) + utf8Bytes(content);
  return n;
}

export const UserSkillList = z
  .array(UserSkill)
  .max(200)
  .refine(list => new Set(list.map(s => s.name)).size === list.length, "two skills have the same name")
  .refine(list => skillsBytes(list) <= USER_SKILLS_MAX_BYTES, `skills can be at most ${USER_SKILLS_MAX_BYTES / 1024} KB in all`);

/** PUT /api/workspace/skills: the whole list, replacing what was there. */
export const PutWorkspaceSkillsRequest = z.object({ skills: UserSkillList });
export type PutWorkspaceSkillsRequest = z.infer<typeof PutWorkspaceSkillsRequest>;

const capped = (max: number, what: string) => z.string().refine(s => utf8Bytes(s) <= max, `${what} can be at most ${max / 1024} KB`);

export const WorkspaceSettingsFields = z.object({
  /** Added to every agent turn's context in the workspace's cloud threads. */
  instructions: capped(INSTRUCTIONS_MAX_BYTES, "instructions"),
  /** Run once in each new sandbox before the runner starts; its output is shown in the thread. */
  setupScript: capped(SETUP_SCRIPT_MAX_BYTES, "the setup script"),
  /** Remove Co-authored-by trailers from the agent's commits. */
  stripCoauthors: z.boolean(),
  /** Retry a turn that failed because the provider was busy or a usage limit was hit, waiting at most this long (0: off). */
  retryMaxWaitMinutes: z.number().int().min(0).max(RETRY_MAX_WAIT_MINUTES_LIMIT),
  /** Close cloud threads (and delete their sandboxes) after this many days without activity; null: never. */
  autoDeleteDays: z.number().int().min(1).max(3650).nullable(),
});

/** PUT /api/workspace/settings: any of the fields; the others stay as they are. */
export const PutWorkspaceSettingsRequest = WorkspaceSettingsFields.partial();
export type PutWorkspaceSettingsRequest = z.infer<typeof PutWorkspaceSettingsRequest>;

export const WorkspaceSettings = WorkspaceSettingsFields.extend({
  /** The workspace's own skills, without their contents (GET /api/workspace/skills has those). */
  skills: z.array(z.object({ name: SkillName, files: z.number().int().nonnegative(), bytes: z.number().int().nonnegative() })),
  /** When they were last changed (ISO), or null if never. */
  updatedAt: z.string().nullable(),
});
export type WorkspaceSettings = z.infer<typeof WorkspaceSettings>;

/** GET/PUT /api/workspace/settings answer. `canEdit` is false for members who aren't owners. */
export const WorkspaceSettingsResponse = z.object({ workspaceId: z.string(), settings: WorkspaceSettings, canEdit: z.boolean() });
export type WorkspaceSettingsResponse = z.infer<typeof WorkspaceSettingsResponse>;

export const DEFAULT_WORKSPACE_SETTINGS: z.infer<typeof WorkspaceSettingsFields> = {
  instructions: "",
  setupScript: "",
  stripCoauthors: false,
  retryMaxWaitMinutes: 0,
  autoDeleteDays: null,
};
