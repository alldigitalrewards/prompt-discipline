---
description: Load and execute a structured implementation plan with batch checkpoints. Usage - /execute-plan (reads plan from context or $ARGUMENTS path)
---

# Executing Plans

## Core Principle
Batch execution with checkpoint reviews. Never execute the entire plan without stopping.

## Workflow

1. **Load the plan** from the user's message or from the file path in $ARGUMENTS
2. **Review critically** before executing:
   - Does the plan make sense given the current codebase state?
   - Are there steps that are already done?
   - Are there steps that conflict with recent changes?
   - Flag any concerns before starting
3. **Execute in batches** of 3-5 related steps
4. **Report after each batch**:
   - What was completed
   - What changed (files modified, tests affected)
   - Any issues encountered
   - What's next
5. **Wait for user approval** before proceeding to the next batch
6. **Verify at the end**: Run relevant tests, type-check, confirm the plan's success criteria are met

## Rules
- If a step fails, stop and report. Don't skip ahead.
- If a step seems wrong, ask before executing.
- Keep a running count: "Completed 5/12 steps"
- After final step, run verification before declaring done.
