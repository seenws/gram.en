---
name: coding-standards
description: Universal coding standards, best practices, and patterns for TypeScript, JavaScript, React, and Node.js. Use when writing, reviewing, or refactoring TS/JS/React/Node code, when deciding how to structure modules/components/APIs, when naming things, handling errors, or resolving "which pattern is better" questions.
---

# Coding Standards

Prescriptive standards for TypeScript, JavaScript, React, and Node.js. Apply
these when writing new code, reviewing a diff, or refactoring. When the
surrounding code already follows a *different but consistent* convention,
match the file you're in — local consistency beats these defaults.

## How to use this skill

1. Apply the **Universal principles** below to any code in these languages.
2. For domain-specific work, read the matching reference file:
   - TypeScript / JavaScript → [references/typescript-javascript.md](references/typescript-javascript.md)
   - React → [references/react.md](references/react.md)
   - Node.js → [references/nodejs.md](references/nodejs.md)
3. When reviewing, cite the specific rule you're applying, not "best practice."

## Universal principles

- **Match existing style first.** Read the neighbouring code. Indentation,
  naming, import order, comment density — mirror what's there before imposing
  these rules. A consistent file in a "wrong" style beats an inconsistent one.
- **Names describe intent, not type or implementation.** `activeUsers`, not
  `userArray`. `retryWithBackoff`, not `doRetry`. Booleans read as
  predicates: `isLoading`, `hasAccess`, `canRetry`.
- **Functions do one thing.** If you need "and" to describe it, split it.
  Keep them short enough to read without scrolling.
- **Make illegal states unrepresentable.** Prefer types/shapes that can't
  hold invalid combinations over runtime checks that guard against them.
- **Fail fast and loud.** Validate inputs at boundaries; throw or return
  early. Never swallow errors silently — no empty `catch {}`.
- **Pure where possible, side effects at the edges.** Push I/O, mutation, and
  randomness to the outer layer; keep the core logic deterministic and
  testable.
- **No dead code, no commented-out code, no `console.log` left behind.**
  Version control remembers; the file shouldn't.
- **Comments explain *why*, not *what*.** The code says what. Comment the
  non-obvious reason, the workaround, the gotcha — not the syntax.
- **Avoid premature abstraction.** Duplicate twice before extracting. A wrong
  abstraction is more expensive than duplication.
- **Handle the error path as deliberately as the happy path.** Every `await`,
  every external call, every parse can fail. Decide what happens when it does.

Code Quality Principles
1. Readability First
- Code is read more than written
- Clear variable and function names
- Self-documenting code preferred over comments
- Consistent formatting

2. KISS (Keep It Simple, Stupid)
- Simplest solution that works
- Avoid over-engineering
- No premature optimization
- Easy to understand > clever code

3. DRY (Don't Repeat Yourself)
- Extract common logic into functions
- Create reusable components
- Share utilities across modules
- Avoid copy-paste programming

4. YAGNI (You Aren't Gonna Need It)
- Don't build features before they're needed
- Avoid speculative generality
- Add complexity only when required
- Start simple, refactor when needed


## Formatting & tooling defaults

- Use the project's formatter/linter config if present (`.prettierrc`,
  `eslint`, `biome`, `tsconfig`). Never reformat to your preference against
  an existing config.
- Default indentation follows the project. **This repo uses 4-space indent
  for `.ts` files** — see the project memory.
- Prefer a linter-enforced rule over a documented one. If a standard here
  matters, it belongs in the lint config, not just in prose.

See the reference files for the concrete, language-specific rules.
