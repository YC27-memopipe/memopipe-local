# CANARY Local (`@canary/local`)

CANARY Local is MemoPipe's consent-based Screenpipe connector and standalone TypeScript automation engine. It searches a user's local Screenpipe recordings, extracts fictional Nimbus IT access cases, asks for review before sharing each case with the hub, and can execute the CANARY DSL against an in-memory adapter. It contains no web server; the companion hub is [memopipe-serv](https://github.com/YC27-memopipe/memopipe-serv).

## Reproducible demo with fixtures

Requires Bun 1.3 or newer. The demo below uses fictional data only and makes no Screenpipe or hub requests.

```sh
bun install --frozen-lockfile
bun test
bun run typecheck
bun run canary:demo
bun run canary:analyze --fixtures fixtures/bob.json --dry-run
```

The demo's expected comparison is **v1: 2/3 cases pass, with exactly four differences on the contractor case; v2: 3/3 pass**. The CLI asks for consent before processing fixture cases and asks separately before accepting each case. Enter `o` to accept or `n` to reject; there is no automatic acceptance option.

## Use real Screenpipe observations

Screenpipe must be running on the same computer. Obtain its local API key privately through `screenpipe auth token`. Configure the local `.env` from the safe template:

```sh
cp -n .env.example .env
# Set values privately; never commit this file.
```

Set `SCREENPIPE_LOCAL_API_KEY`, `CANARY_HUB_URL`, `CANARY_TEAM_TOKEN`, and `CANARY_AUTHOR=Bob`. The hub token must match `MEMOPIPE_TEAM_TOKEN` in the hub. Then run:

```sh
bun run canary:analyze --hub http://127.0.0.1:3000 --automation attribuer-acces --since 24h --dry-run
```

`--dry-run` prevents scenario uploads. Remove it only when you intend to send individually approved scenarios to the hub. For a live upload, the hub must be HTTPS unless it is on loopback. A captured Screenpipe observation can include private text; inspect every proposed case and citation before consenting to transfer.

The CLI checks Screenpipe health after consent. It searches a fixed time range in the `Tickets Nimbus` and `Console des permissions` windows, tries accessibility first, and falls back to OCR if it finds no usable observations. It paginates results, groups ticket and console observations, and rejects incomplete or ambiguous cases. It never silently falls back to fixtures. `--save` writes a private local copy without overwriting an existing file; keep real recordings under ignored `local-data/` and do not commit them.

For hub-driven discovery, configure the same local settings and run this on the computer with Screenpipe:

```sh
bun run canary:agent
```

Then open **Discover** in the hub as the configured author. The user separately consents to bounded history reading and to sharing the selected structured report. Gmail is not needed for discovery.

## Commands

| Command | Purpose |
| --- | --- |
| `bun run canary:analyze --fixtures fixtures/bob.json --dry-run` | Extract and review fictional cases without uploading |
| `bun run canary:analyze --since 24h --dry-run` | Read approved local Screenpipe scope; do not upload |
| `bun run canary:discover --fixtures fixtures/bob.json --dry-run` | Preview fictional discovery input locally |
| `bun run canary:agent` | Poll the hub for explicitly queued jobs and use local Screenpipe |
| `bun run canary:check-screenpipe --cli-auth --window memopipe --since 5m --page-size 2` | Check selected local observations; prints metadata, not captured text |
| `bun run test:integration` | Exercise HTTP behavior against local simulated services |
| `bun run test:package` | Pack, install, type-check, and run the package in an independent TypeScript project |

Common options: `--hub <origin>`, `--automation <id>`, `--since <30m|24h|2d>`, `--fixtures <path>`, `--save <path>`, and `--dry-run`. Fixture files declare their own period. Live search is bounded to at most 365 days.

## DSL and TypeScript engine

See [examples/v1.canary](examples/v1.canary), [examples/v2.canary](examples/v2.canary), and the [integration contract](docs/integration.md).

```ts
import { compile, start, step, finish, MemoryAdapter } from "@canary/local";

const adapter = new MemoryAdapter();
const program = compile(dsl);
let state = await start(program, scenario, adapter);
state = await step(state, adapter); // execute one visible instruction
const { state: done, comparison } = await finish(state, adapter);
```

The DSL supports `SET`, `DO`, `IF`/`ELSE`/`END`, expressions, and interpolation. Built-in actions are `iam.grant`, `tickets.comment`, and `tickets.close`; the memory adapter is for isolated tests and demos. The standalone runner does not connect to real GitHub, VPN, Slack, or Nimbus systems.

## Gmail boundary

The local agent contains legacy handlers: `gmail.search` reads Screenpipe's configured IMAP connection, and `gmail.send` opens Gmail in a Screenpipe-controlled browser and clicks Send. These handlers are not required by the MemoPipe discovery flow. The hub currently blocks Gmail actions in its test policy, and no end-to-end Gmail integration was validated for this submission. Do not treat a local handler result as proof of email delivery.

## Validation and boundaries

The latest documented run on 18 October 2026 passed **107 tests**, TypeScript checking, the CLI demo, and package installation/execution in an independent TypeScript project. Tests use simulated Screenpipe and hub responses; they do not establish that current Screenpipe recordings contain a usable Nimbus case. The hub has a separate runner implementation; this repository is connected by scenario/report contracts and is not imported by the hub.

Screenpipe observations and saved files may contain private text. Consent is required for reading and sharing. Provenance labels distinguish fixtures from captured observations but are declarative, not cryptographic. Read the [hub README](https://github.com/YC27-memopipe/memopipe-serv#prototype-limits) for the combined system's limits.
