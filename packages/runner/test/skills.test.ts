import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { branchForThread, type AgentKind, type Thread } from "@lemonlime/protocol";
import { BUNDLED_SKILLS_DIR, listSkills, ThreadRunner, type AgentAdapter } from "../src/index.ts";

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
    expect(names).toEqual(["lemonlime-ask-when-blocked", "lemonlime-git-hygiene", "lemonlime-open-pr", "lemonlime-run-tests-first"]);
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
