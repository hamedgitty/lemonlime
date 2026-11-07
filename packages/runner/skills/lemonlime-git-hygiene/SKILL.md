---
name: lemonlime-git-hygiene
description: How to work with git in a LemonLime thread. Use whenever you are about to run git commands, switch branches, commit, rebase, or touch files outside the task.
---

# Git in a LemonLime thread

You are working on the thread's own branch (`agent/<thread-id>`), often in a separate
git worktree. LemonLime commits your changes for you after every turn.

- **Stay on this branch.** Don't `git checkout`, `git switch` or create branches unless the
  user asks. Never check out `main` or another person's branch here.
- **Don't rewrite history.** No `git reset --hard`, `git push --force`, `git rebase` or
  `git commit --amend` on commits that already exist, unless the user asks for it.
- **Don't commit by hand** unless the user asks. Your changes are committed at the end of
  each turn with a message taken from the user's request.
- **Keep the diff about the task.** Don't reformat whole files, rename things in passing,
  or add unrelated "cleanups". Small, focused changes are easier to review.
- **Never commit secrets.** Leave `.env` files, keys and tokens out of the repository. If
  the task needs a secret, ask the user to add it as an environment variable.
- **Leave generated and build output alone** (`node_modules`, `dist`, `.next`, `target`)
  unless the task is about them.
- Before finishing, run `git status` and `git diff` and check that every change is one you
  meant to make.
