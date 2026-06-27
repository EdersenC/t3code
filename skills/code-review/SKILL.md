---
name: code-review
description: Review source changes for correctness, regressions, reliability, security, and missing tests. Use when the user asks for a review, PR review, diff audit, bug hunt, risk assessment, or validation of implementation quality.
metadata:
  short-description: Review changes for bugs and regressions
---

# Code Review

Use a code-review stance.

1. Inspect the relevant diff and nearby code before judging behavior.
2. Prioritize findings that can cause incorrect behavior, regressions, security issues, data loss, degraded reliability, or missing coverage for risky behavior.
3. Ground each finding in a file and line when possible. Explain the user-visible or operational impact, not just the style concern.
4. Keep summaries brief and secondary. Lead with findings ordered by severity.
5. If no actionable issues are found, say that clearly and mention any remaining test gaps or residual risk.

Avoid broad refactors, preference-only comments, and low-signal style nits unless they block correctness or maintainability.
