---
name: prompt-coach
description: Enriches vague user instructions with project context before execution. When a prompt is ambiguous, gathers git state, test output, workspace docs, and recent changes to fill in missing specifics. Prevents wrong outputs from underspecified prompts.
allowed-tools:
  - Task
  - Read
  - Bash
  - Glob
  - Grep
---

# Prompt Coach Skill

## When to Activate

This skill should be invoked (either manually via `/prompt-discipline:prompt-coach` or automatically by the ambiguity hook) when a user instruction is missing 2 or more of:

1. **Target**: Which specific file(s), component(s), or test(s)?
2. **Action**: What exactly should change? (not just "fix" or "update")
3. **Scope**: What are the boundaries? (which suite, role, branch, directory)
4. **Done condition**: How do we verify it's complete?

## Workflow

### Step 1: Assess the Instruction

Parse the user's last message. Score each criterion:
- ✅ Present and specific
- ⚠️ Implied but ambiguous
- ❌ Missing entirely

If 2+ are ❌ or ⚠️, proceed to Step 2. Otherwise, execute normally.

### Step 2: Gather Context

Run these in parallel to fill in the gaps:

**For missing Target:**
```bash
git diff --name-only HEAD~3        # Recently changed files
git diff --staged --name-only      # Currently staged
```

**For missing Action:**
```bash
# Check for failing tests
pnpm test 2>&1 | tail -20
# Check for type errors
pnpm tsc --noEmit 2>&1 | tail -20
# Check git status
git status --short
```

**For missing Scope:**
```bash
# Read workspace docs for current priorities
cat .claude/playwright-test-suite/GAP-TRACKER.md 2>/dev/null | head -30
cat .claude/pre-merge/gaps.md 2>/dev/null | head -30
```

**For missing Done condition:**
- Infer from context: if it's a test fix, done = tests pass. If it's a feature, done = tests pass + type-check clean.

### Step 3: Decide

Based on gathered context, choose ONE path:

**Path A: Proceed with confidence** — if context fills in all gaps unambiguously.
Report what you inferred:
> "Based on git diff and test output, I'm interpreting 'fix the tests' as: fix the 3 failing specs in tests/functional/ui/challenges/admin/ where h1 selectors match nav instead of page heading. I'll run the admin suite to verify. Proceeding."

**Path B: Ask ONE question** — if context still leaves ambiguity.
Ask the single most disambiguating question:
> "There are failing tests in both admin/ (3 failures) and participant/ (2 failures). Should I fix admin first, or all 5 at once?"

Never ask more than one question. Never list options without a recommendation.

### Step 4: Execute

Once the instruction is specific, execute it. Include in your first response:
- What you're doing (specific files, specific changes)
- How you'll verify (which test suite, which command)
- When you'll check in (after N files, after first test run)

## Anti-Patterns to Catch

| User says | Problem | Coach response |
|-----------|---------|---------------|
| "fix the tests" | Which tests? What's broken? | Check test output, identify specific failures, report before fixing |
| "commit this" | Commit message? Which files? Push? | Run git status, group changes, ask "push to remote too?" |
| "remove them" | Remove what from where? | Check recent conversation context, confirm the specific items |
| "check everything" | Unbounded scope | Run scope-first inventory, present checklist |
| "yes add them" | Add what? Where? Following what pattern? | Check conversation history for the "them", confirm before acting |
| "make it work" | No specific failure identified | Run tests/build, identify specific errors, fix those |

## Rules

1. **Never guess silently.** If you're inferring, say what you inferred.
2. **Never ask more than one question.** Pick the highest-leverage disambiguation.
3. **Always show your work.** "I checked git diff and found X, test output shows Y, so I'm doing Z."
4. **Prefer action over questions.** If you can figure it out from context, do it and report — don't ask.
5. **Track your enrichments.** At session end, note which prompts needed coaching for the user's review.
