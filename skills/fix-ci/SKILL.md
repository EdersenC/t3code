---
name: fix-ci
description: Diagnose and fix failing checks, tests, typechecks, linters, builds, and CI jobs. Use when the user mentions CI failure, red checks, test failure, typecheck failure, lint failure, build failure, or asks to get checks passing.
metadata:
  short-description: Fix failing tests, builds, and checks
---

# Fix CI

Use a tight failure-driven workflow.

1. Reproduce the failure with the narrowest available command before editing when practical.
2. Read the exact error and trace it to source code, configuration, generated types, or test expectations.
3. Make the smallest robust fix that addresses the root cause.
4. Re-run the failing command, then broaden verification when the change touches shared behavior.
5. Report the command results and any remaining unrelated failures separately.

Preserve unrelated user changes and avoid masking failures by weakening tests or disabling checks unless the user explicitly asks for that tradeoff.
