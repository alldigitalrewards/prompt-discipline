---
description: Check status of all spawned sub-agents in one call. Replaces repeated polling.
---

Check on ALL currently running and recently completed sub-agents. For each agent, report in this exact format:

| Agent | Status | Last Action | Result |
|-------|--------|-------------|--------|
| {name/id} | running/done/failed | {what it's doing/did} | {pass/fail count or key output} |

Then summarize:
- **Done**: X agents completed successfully
- **Running**: X agents still working
- **Failed**: X agents need attention (list what went wrong)
- **Next**: What should happen when all are done?

Do NOT ask follow-up questions. Just gather the status and report.
