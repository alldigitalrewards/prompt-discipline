---
description: Atomic git commit workflow. Check status, stage, commit in logical batches with descriptive messages, push to remote.
---

Follow this exact workflow:

1. Run `git status` and `git diff --stat` to see all changes
2. Group related changes into logical commits (by feature/area, not by file type)
3. For each group:
   - `git add` the relevant files
   - Write a descriptive commit message following conventional commits (feat:, fix:, docs:, chore:, test:)
   - `git commit`
4. `git push` to the current branch
5. Report: number of commits, files committed, current branch, remote status
