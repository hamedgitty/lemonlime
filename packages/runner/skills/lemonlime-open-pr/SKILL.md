---
name: lemonlime-open-pr
description: Open a pull request for the thread's branch. Use when the user asks for a pull request, a PR, or to send the work for review.
---

# Open a pull request

Only open a pull request when the user asks for one.

1. Make sure the work is finished: tests pass (see `lemonlime-run-tests-first`) and
   `git status` shows nothing you didn't mean to change.
2. Write a title in plain words, under 70 characters, saying what changes for the user
   (e.g. "Show a clear error when the upload is too large").
3. Write a short body: what changed, why, and how you checked it. Mention anything the
   reviewer should look at closely, and anything you couldn't test.
4. Push the thread's branch (`git push -u origin HEAD`). LemonLime may already have pushed
   it; pushing again is fine.
5. If the GitHub CLI is available and signed in (`gh auth status`), run
   `gh pr create --title "..." --body "..."` against the repository's default branch.
   Otherwise, give the user the branch name and the repository's compare link so they can
   open it themselves.
6. Reply with the pull request link.

Never force-push, and never open a pull request against a branch the user didn't mention
other than the default branch.
