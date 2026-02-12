---
description: Enumerate scope before starting open-ended work. Prevents unbounded sessions that compact.
---

Before doing ANY implementation work, produce a scope inventory:

1. **Pages/Routes** in the target area — list every file with its URL path
2. **Roles** that access each page — admin, client, manager, participant
3. **Current test coverage** — which pages have specs, which don't
4. **Components** — shared vs feature-specific in the target area

Output as a numbered checklist the user can select from:

```
[ ] 1. /admin/challenges — admin — has spec ✅
[ ] 2. /admin/challenges/[id] — admin — no spec ❌
[ ] 3. /manager/challenges — manager — has spec ✅
...
```

Then ask: "Which items should I work on? Or should I do all of them?"

This prevents unbounded "check everything" sessions that burn through context.
