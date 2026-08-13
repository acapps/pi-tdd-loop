# pi-tdd-loop

Adversarial 3-agent test-driven development loop for [pi](https://pi.dev).

Three AI agent roles take turns — **Tester** writes the contract (stubs + tests), **Writer** implements to pass them, **Cleaner** refactors for readability. Each phase is gated by independent build/test/coverage checks. If the Writer disagrees with a test, it can **dispute** and the Tester must defend or concede.

## Language Support

- **Go** — `go build`, `go test -json`, `go test -cover`
- **Java (Maven)** — `mvn compile`, `mvn test`, `mvn jacoco:report`
- **TypeScript** — `npx tsc --noEmit`, `npx vitest run`

Language is auto-detected from project files (`go.mod`, `pom.xml`, `package.json`) or set explicitly with `--language`.

## Quick Start

```bash
# Install from git
pi install git:github.com/YOU/pi-tdd-loop@v1

# Or run from source
pi -e ./path/to/pi-tdd-loop
```

```bash
# Start the loop with a spec file
/loop path/to/spec.md

# With options
/loop --coverage 90 path/to/spec.md
/loop --language java path/to/spec.md
```

## Commands

| Command | Description |
|---|---|
| `/loop [options] <spec>` | Start the loop at Phase A |
| `/loop-status` | Show current phase, round, gate results |
| `/loop-continue` | Resume from current phase after escalation |
| `/loop-restart <phase>` | Jump to a specific phase |
| `/loop-debug` | Show last 20 debug entries |
| `/loop-cancel` | Stop the loop, return to idle |

## How It Works

```
Phase A (Tester) → Negotiate → Phase B (Writer) → Phase C (Cleaner) → Done
     │                    │               │                  │
     ▼                    ▼               ▼                  ▼
  Compile gate       Approve or       Test +           Test gate
  (stubs + tests)    feedback         Coverage gate    (refactor safe)
```

### Phase A — Tester writes the contract

Tester reads the spec, writes stub signatures and comprehensive test suites. Gate: code must compile.

### Negotiate — Writer proposes, Tester approves

Writer reads the spec and tests, then proposes an implementation approach. Tester reviews and approves or gives feedback.

### Phase B — Writer implements

Writer fills in the stubs to pass all tests. Gate: all tests pass + coverage ≥ threshold. Writer can **dispute** tests it believes are wrong — the Tester must defend or concede.

### Phase C — Cleaner refactors

Cleaner improves readability: extract helpers, return early, clear names. Gate: tests still pass (coverage not re-checked — refactoring may restructure without changing test surface).

## Escalation

If rounds are exhausted (compilation failures, negotiation impasse, implementation failures, dispute limits), the loop escalates to you. Use `/loop-continue` to resume or `/loop-restart <phase>` to jump.

## Works with Graphify

The loop pairs well with the [Graphify](https://github.com/pi-dev/pi-extensions/tree/main/graphify) extension for project knowledge graphs. Install Graphify separately and use `/graphify-build` before or after the loop for best results.

## Development

```bash
npm install
npm test
```

## License

TODO
