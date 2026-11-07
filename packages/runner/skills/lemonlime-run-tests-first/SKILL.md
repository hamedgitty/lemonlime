---
name: lemonlime-run-tests-first
description: Find and run the project's tests before and after changing code. Use at the start of any task that changes behaviour, fixes a bug, or refactors.
---

# Run the tests first

1. **Find how this project tests.** Look at `package.json` scripts, `Makefile`,
   `pyproject.toml`, `Cargo.toml`, `go.mod`, CI files in `.github/workflows`, and the
   README. Prefer the command CI uses.
2. **Run them before you change anything,** so you know what already fails. If the full
   suite is slow, run the part closest to your change.
3. **For a bug fix, write or find a test that fails first,** then make it pass.
4. **Run them again when you're done.** Also run the project's type checker and linter if
   it has them.
5. **Report honestly.** Say what you ran and what passed. If something still fails, say
   which test and why; never claim tests pass when you didn't run them. If tests can't run
   here (missing service, missing secret), say exactly what's missing.
