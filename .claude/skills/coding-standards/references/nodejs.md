# Node.js

## Modules & runtime

- **ESM (`import`/`export`), `"type": "module"`.** Use the `node:` prefix for
  built-ins (`import { readFile } from 'node:fs/promises'`).
- **Async built-ins over sync.** Use `fs/promises`, not `fs.readFileSync`,
  outside of startup/CLI scripts. Never block the event loop in a request path.
- **Don't reinvent built-ins.** `fetch`, `crypto`, `AbortController`,
  `structuredClone`, and the `node:test` runner are built in on modern Node.

## Configuration & secrets

- **Config comes from the environment**, validated once at startup into a typed
  config object (e.g. with `zod`). Fail fast on missing/invalid env vars.
- **Never commit secrets.** No credentials in code, logs, or error messages.
- **Pin the Node version** with `engines` in `package.json` and an
  `.nvmrc`/`.node-version`.

## Errors & process lifecycle

- **Throw `Error` subclasses with context;** set `.cause` when wrapping.
- **Distinguish operational errors** (expected: bad input, network blip —
  handle and recover) **from programmer errors** (bugs — let them crash).
- **Handle `unhandledRejection` and `uncaughtException`** at the top level:
  log, then exit on truly unexpected errors rather than limping on.
- **Graceful shutdown:** listen for `SIGTERM`/`SIGINT`, stop accepting work,
  drain in-flight requests, close DB/pool connections, then exit.

## Servers & APIs

- **Validate all external input at the boundary** (body, query, params,
  headers) with a schema before it reaches business logic.
- **Centralised error-handling middleware;** never leak stack traces or
  internal details to clients. Return structured errors with correct status
  codes.
- **Set timeouts** on outbound calls and use `AbortController`/`AbortSignal` to
  cancel. No unbounded waits.
- **Stream large payloads;** don't buffer whole files/responses in memory.
- **Structured logging** (JSON via `pino`/`winston`), not `console.log`.
  Include request/correlation IDs; never log secrets or PII.

## Security

- **Least privilege** for tokens, DB users, and file permissions.
- **Parameterised queries / prepared statements** — never string-concatenate
  SQL or shell commands. Prefer `execFile` over `exec`; avoid `shell: true`.
- **Keep dependencies current;** run `npm audit` and minimise the dependency
  surface. Vet before adding.

## Performance

- **Offload CPU-bound work** to worker threads or a queue; keep the main loop
  responsive.
- **Reuse connections** (DB/HTTP pools); don't open per-request.
- **Cache deliberately** with explicit TTLs and invalidation, not ad hoc.
