---
description: Finish development work on current branch. Push, create PR, run review. Usage - /finish-branch [target-branch]
---

# Finishing a Development Branch

Target branch: $ARGUMENTS (default: staging)

## Workflow

1. **Check state**: `git status`, `git log --oneline -5`, confirm all work is committed
2. **If uncommitted changes exist**: Run the commit-all workflow first
3. **Present options**:
   - **Option 1**: Merge locally to target branch
   - **Option 2**: Push and create PR against target branch
   - **Option 3**: Just push (no PR)
4. **Execute chosen option**
5. **If PR created**: 
   - Include a summary of changes in the PR description
   - List files changed and test results
   - Run code review if `@pr-review-toolkit:code-reviewer` agent is available
6. **Report**: PR URL, branch status, any CI checks triggered

## Rules
- Always verify tests pass before creating PR
- Run `pnpm tsc` type-check before push
- If conflicts exist with target, list them and ask how to resolve
