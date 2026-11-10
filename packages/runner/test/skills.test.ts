import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { branchForThread, type AgentKind, type Thread } from "@lemonlime/protocol";
import { BUNDLED_SKILLS_DIR, installSkills, listSkills, ThreadRunner, type AgentAdapter } from "../src/index.ts";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })));
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), "lemonlime-skills-"));
  dirs.push(d);
  return d;
};
const git = (dir: string, ...a: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: dir })
    .toString()
    .trim();

function repo(): string {
  const dir = temp();
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "a.txt"), "a\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "init");
  return dir;
}

function thread(id: string, kind: AgentKind): Thread {
  const now = new Date().toISOString();
  return {
    id,
    title: "",
    agent: { kind },
    repo: { url: "local", baseBranch: "main" },
    branch: branchForThread(id),
    mode: "local",
    status: "provisioning",
    sandboxSize: "small",
    latestSeq: 0,
    mine: true,
    shared: false,
    createdAt: now,
    updatedAt: now,
  };
}

const editing = (kind: AgentKind): AgentAdapter => ({
  kind,
  createSession: opts => ({
    async runTurn() {
      writeFileSync(join(opts.cwd, "a.txt"), "changed\n");
    },
    saveState: () => ({}),
    dispose: async () => {},
  }),
});

describe("bundled skills", () => {
  it("each has a SKILL.md whose name matches its folder and says when to use it", () => {
    const names = listSkills(BUNDLED_SKILLS_DIR);
    expect(names).toEqual(["lemonlime-ask-when-blocked", "lemonlime-git-hygiene", "lemonlime-open-pr", "lemonlime-previews", "lemonlime-run-tests-first"]);
    for (const name of names) {
      const text = readFileSync(join(BUNDLED_SKILLS_DIR, name, "SKILL.md"), "utf8");
      const front = /^---\n([\s\S]+?)\n---\n/.exec(text)?.[1] ?? "";
      expect(front, name).toContain(`name: ${name}`);
      expect(/description: .*Use (when|whenever|at)/.test(front), name).toBe(true);
    }
  });

  it.each([
    ["claude-code", ".claude/skills"],
    ["codex", ".agents/skills"],
    ["opencode", ".agents/skills"],
  ] as const)("puts them where %s looks and never commits them", async (kind, folder) => {
    const dir = repo();
    const extra = temp();
    mkdirSync(join(extra, "team-style"));
    writeFileSync(join(extra, "team-style", "SKILL.md"), "---\nname: team-style\ndescription: Our style. Use always.\n---\n");
    const runner = new ThreadRunner({
      thread: thread(`skills-${kind}`, kind),
      workdir: dir,
      dataDir: join(dir, ".lemonlime"),
      adapter: editing(kind),
      session: { autonomy: "edits" },
      extraSkillDirs: [extra],
    });
    await runner.init();
    expect(existsSync(join(dir, folder, "lemonlime-git-hygiene", "SKILL.md"))).toBe(true);
    expect(existsSync(join(dir, folder, "team-style", "SKILL.md"))).toBe(true);

    runner.sendMessage("change a.txt");
    await runner.settled();
    await runner.close();
    const committed = git(dir, "show", "--name-only", "--format=", "HEAD");
    expect(committed).toBe("a.txt");
    expect(
      runner.store
        .since(0)
        .filter(e => e.type === "file_diff")
        .map(e => (e as { path: string }).path),
    ).toEqual(["a.txt"]);
  });

  it("can be turned off", async () => {
    const dir = repo();
    const runner = new ThreadRunner({
      thread: thread("skills-off", "codex"),
      workdir: dir,
      dataDir: join(dir, ".lemonlime"),
      adapter: editing("codex"),
      session: { autonomy: "edits" },
      bundledSkills: false,
    });
    await runner.init();
    await runner.close();
    expect(existsSync(join(dir, ".agents"))).toBe(false);
  });
});

describe.skipIf(process.platform === "win32")("links, when skills are copied into a thread's folder", () => {
  /** A folder of the user's skills holding one skill, "notes". */
  function oneSkill(): { skills: string; skill: string } {
    const skills = temp();
    const skill = join(skills, "notes");
    mkdirSync(join(skill, "parts"), { recursive: true });
    writeFileSync(join(skill, "SKILL.md"), "---\nname: notes\ndescription: Keep notes.\n---\n");
    writeFileSync(join(skill, "parts", "real.md"), "the real file\n");
    return { skills, skill };
  }
  const install = (workdir: string, skills: string, kind: AgentKind = "claude-code") =>
    installSkills({ workdir, kind, git: null, bundled: false, extraDirs: [skills] });
  const isLink = (path: string) => lstatSync(path).isSymbolicLink();

  it("keeps a link that points inside the skill and leaves out one that points anywhere else", async () => {
    const { skills, skill } = oneSkill();
    const elsewhere = temp();
    writeFileSync(join(elsewhere, "private.txt"), "not part of the skill\n");
    symlinkSync(join("parts", "real.md"), join(skill, "inside.md"));
    symlinkSync(join(elsewhere, "private.txt"), join(skill, "outside.txt"));
    symlinkSync(elsewhere, join(skill, "outside-folder"));
    symlinkSync(join(elsewhere, "missing"), join(skill, "nowhere"));
    const workdir = temp();

    expect(await install(workdir, skills)).toEqual(["notes"]);
    const copy = join(workdir, ".claude", "skills", "notes");
    expect(readdirSync(copy).sort()).toEqual(["SKILL.md", "inside.md", "parts"]);
    expect(isLink(join(copy, "inside.md"))).toBe(true);
    expect(readFileSync(join(copy, "inside.md"), "utf8")).toBe("the real file\n");
  });

  it("copies a skill the user keeps as a link to a folder somewhere else", async () => {
    const { skills, skill } = oneSkill();
    const linked = temp();
    symlinkSync(skill, join(linked, "notes"));
    const workdir = temp();

    expect(await install(workdir, linked)).toEqual(["notes"]);
    const copy = join(workdir, ".claude", "skills", "notes");
    expect(isLink(copy)).toBe(false);
    expect(readFileSync(join(copy, "parts", "real.md"), "utf8")).toBe("the real file\n");
    expect(skills).not.toBe(linked);
  });

  it("writes nothing through a link that leads out of the thread's folder", async () => {
    const { skills } = oneSkill();
    for (const linkAt of [".claude", ".claude/skills", ".claude/skills/notes"]) {
      const workdir = temp();
      const elsewhere = temp();
      mkdirSync(join(workdir, linkAt, ".."), { recursive: true });
      symlinkSync(elsewhere, join(workdir, linkAt));

      expect(await install(workdir, skills), linkAt).toEqual([]);
      expect(readdirSync(elsewhere), linkAt).toEqual([]);
    }
  });

  it("follows a link that stays inside the thread's folder", async () => {
    const { skills } = oneSkill();
    const workdir = temp();
    mkdirSync(join(workdir, ".claude", "skills"), { recursive: true });
    mkdirSync(join(workdir, ".agents"));
    symlinkSync(join("..", ".claude", "skills"), join(workdir, ".agents", "skills"));

    expect(await install(workdir, skills, "codex")).toEqual(["notes"]);
    expect(existsSync(join(workdir, ".claude", "skills", "notes", "SKILL.md"))).toBe(true);
    expect(isLink(join(workdir, ".agents", "skills"))).toBe(true);
  });

  it("replaces a link left where one of the skill's files goes, instead of writing through it", async () => {
    const { skills } = oneSkill();
    const workdir = temp();
    const elsewhere = temp();
    writeFileSync(join(elsewhere, "keep.txt"), "keep me\n");
    const copy = join(workdir, ".claude", "skills", "notes");
    mkdirSync(copy, { recursive: true });
    symlinkSync(join(elsewhere, "keep.txt"), join(copy, "SKILL.md"));
    symlinkSync(elsewhere, join(copy, "parts"));

    expect(await install(workdir, skills)).toEqual(["notes"]);
    expect(readFileSync(join(elsewhere, "keep.txt"), "utf8")).toBe("keep me\n");
    expect(readdirSync(elsewhere)).toEqual(["keep.txt"]);
    expect(isLink(join(copy, "SKILL.md"))).toBe(false);
    expect(readFileSync(join(copy, "SKILL.md"), "utf8")).toContain("name: notes");
    expect(readFileSync(join(copy, "parts", "real.md"), "utf8")).toBe("the real file\n");
  });

  it("skips a link in the skills folder that leads nowhere", () => {
    const { skills } = oneSkill();
    symlinkSync(join(skills, "gone"), join(skills, "broken"));
    expect(listSkills(skills)).toEqual(["notes"]);
  });
});
