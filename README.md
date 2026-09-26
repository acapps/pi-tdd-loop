# pi-tdd-loop

Adversarial 3-agent test-driven development loop for [pi](https://pi.dev).

Three AI agent roles take turns — **Tester** writes the contract (stubs + tests), **Writer** implements to pass them, **Cleaner** refactors for readability. Each phase is gated by independent build/test/coverage checks. If the Writer disagrees with a test, it can **dispute** and the Tester must defend or concede.

Before any code is written, the loop checks two things: your **existing test suite is green** (baseline), and your **spec** is reviewed for ambiguities and missing edge cases so you can clarify once, up front — not mid-loop.

## Language Support

- **Go** — `go build`, `go test -json`, `go test -cover`
- **Java (Maven)** — `mvn compile`, `mvn test`, `mvn jacoco:report`
- **TypeScript** — `npx tsc --noEmit`, `npx vitest run`

Language is auto-detected from project files (`go.mod`, `pom.xml`, `package.json`) or set explicitly with `--language`.

## Quick Start

```bash
# Install from git
pi install git:github.com/acapps/pi-tdd-loop

# Or run from source
pi -e ./path/to/pi-tdd-loop
```

```bash
# Start the loop with a spec file
/loop path/to/spec.md

# With options
/loop --coverage 90 path/to/spec.md
/loop --language java --timeout 120 path/to/spec.md
/loop --no-auto-approve path/to/spec.md
/loop --branch feature/my-change path/to/spec.md
```

## Commands

| Command | Description |
|---|---|
| `/loop [options] <spec>` | Start the loop (baseline check, then Phase 0 review) |
| `/loop-approve` | Approve Phase 0 review and proceed to Phase A |
| `/loop-status` | Show current phase, round, gate results |
| `/loop-continue` | Resume from current phase after escalation |
| `/loop-restart <phase>` | Jump to a specific phase |
| `/loop-debug` | Show last 20 debug entries; `--log-bug <name>` writes `bug-fix-<name>.md` |
| `/loop-patch <spec>` | Mid-loop spec correction: re-read spec, reset round, record patch entry |
| `/loop-decompose <spec>` | Split a large spec into sub-specs (stateless, no loop state change) |
| `/loop-stop` | Stop the loop, escalate to human |
| `/loop-cancel` | Stop the loop, return to idle |
| `/spec [options] <goal>` | One-shot Author: writes a /loop-ready spec into the backlog (no loop state) |

### `/loop` options

| Flag | Description |
|---|---|
| `--language go\|java\|typescript` | Override auto-detection |
| `--coverage N` | Coverage threshold (default 80) |
| `--timeout N` | Gate command timeout in seconds (default 60) |
| `--branch [name]` | Run on a git feature branch (default: `loop/<spec-slug>`) |
| `--no-auto-approve` | Disable Phase 0 auto-advance (default: auto-approve when review is clean) |

### Project config

Place a `loop.config.json` in your project root (or `.pi/loop.config.json`) to set defaults:

```json
{
  "coverage": 90,
  "language": "go",
  "timeout": 120,
  "autoApprove": true
}
```

CLI flags override config file values.

### `/spec`

`/spec [--slug <name>] [--out <dir>] <goal...>` is the spec-writing half of the workflow: it runs one Author turn that reads your loose goal, verifies claims against the repo, and writes a tight spec file (default `internal/<slug>.md`) shaped to the [spec template](docs/spec-authoring.md). It is a separate, stateless command — no loop phases, no gates, no `LoopState` — so spec-writing and implementation can each take their own session. When the spec is ready, kick off the implementation half with `/loop internal/<slug>.md`.

**Why `/spec` helps but isn't required.** The spec's Test Strategy section is the reconnaissance: it tells the Phase A Tester exactly which tests to write, where to put them, and what edge cases matter. Without it, the Tester must do that reconnaissance itself, which is where loops tend to sprawl (observed: 55-minute read-only stall with zero test files written). The Phase A prompt now handles both cases: if the spec has a Test Strategy section, the Tester transcribes it; if not, the Tester reads the codebase, writes a `## Test Strategy` section into the spec, and then writes the tests. Either way, the reconnaissance is explicit (produces a section) rather than implicit (open-ended exploration). `/spec` is the faster path because it does the reconnaissance in a single focused Author turn; `/loop` without `/spec` works but spends more of Phase A on the same work.

### `/loop-debug --log-bug`

`/loop-debug --log-bug <name>` extracts the session's `loop-*` debug entries in-process and writes `bug-fix-<slug>.md` into the working directory — a self-contained, `/loop`-runnable bug spec with an auto-filled Context (phase/round/spec/language), placeholder Observed problem / Proposed fix sections, and the extracted log excerpt inlined. Fill the placeholders in, then run `/loop bug-fix-<slug>.md`.

### Git branch workflow (opt-in)

`/loop --branch [name] <spec>` runs the whole loop on a git feature branch and merges it back when the loop completes:

- **Opt-in**: without `--branch` the loop never touches git. With it, a branch is created off the mainline (`origin/HEAD` → `main` → `master`) before Phase 0. The default name is `loop/<spec-slug>` derived from the spec filename; pass `--branch <name>` (or `--branch=<name>`) to override.
- **Clean tree guard**: the loop refuses to start on a dirty working tree.
- **Merge back on completion**: when the loop reaches done, uncommitted work is committed on the feature branch, the branch is merged into the mainline (`--no-ff`), and you land back on the mainline.
- **Single conflict attempt**: if the merge conflicts, the Writer gets exactly one turn to resolve it. If the merge is still broken after that turn, the loop escalates to you with the conflicted files — no retry loops.
- **State persistence**: the branch is recorded in the loop state, so `/loop-continue` and `/loop-restart` resume on the existing branch instead of re-branching. `/loop-status` shows the branch and its merge state.

## How It Works

```
Phase 0 (Baseline + Review) → Phase A (Tester) → Negotiate → Phase B (Writer) → Phase C (Cleaner) → Done
     │                             │                │               │                  │
     ▼                             ▼                ▼               ▼                  ▼
  Suite must be green         Compile gate     Approve or       Test +           Test gate
  + ambiguity check           (stubs + tests)  feedback         Coverage gate    (refactor safe)
```

### Runtime guards

- **Reconnaissance breaker**: after 15 read-only tool calls (reads, greps, git status) without any write/edit in a single turn, the agent is blocked from further reads and told to act on what it has. Any write/edit resets the counter. This prevents self-perpetuating reconnaissance loops where the agent reads and re-reads files indefinitely instead of writing code or tests. Complements the exact-match repeated-call breaker (5× identical calls).
- **Scope-check baseline**: the loop captures `git status --porcelain` at spec start (Phase 0). The scope-check gate filters out these pre-existing untracked files, so only files created or modified *during* the loop are checked against the spec's Inventory. Prevents false out-of-scope failures when the working tree has untracked artifacts from prior work.
- **Clean tree guard**: the loop refuses to start on a dirty working tree.

### Phase 0 — Baseline + spec review

First, the loop runs your existing test suite: all tests must pass, or you must have no tests yet. If the suite is red — or the test runner is unavailable — `/loop` stops with the failing tests and will not start a loop on top of a broken baseline. Then the Reviewer reads your spec and surfaces ambiguities, missing edge cases, and underspecified behavior. You approve, reject, or modify each finding before any code is written. This shifts you from firefighter (reacting to disputes mid-loop) to reviewer (approving clarifications up front). Specs written against the template in [docs/spec-authoring.md](docs/spec-authoring.md) tend to clear Phase 0 in a single pass.

By default, a clean review (no feedback, no dispute) auto-advances to Phase A. Use `--no-auto-approve` to require an explicit `/loop-approve`.

### Phase A — Tester writes the contract

Tester reads the spec, writes stub signatures and comprehensive test suites. Gate: code must compile.

### Negotiate — Writer proposes, Tester approves

Writer reads the spec and tests, then proposes an implementation approach. Tester reviews and approves or gives feedback.

### Phase B — Writer implements

Writer fills in the stubs to pass all tests. Gate: all tests pass + coverage ≥ threshold. Writer can **dispute** tests it believes are wrong — the Tester must defend or concede.

### Phase C — Cleaner refactors

Cleaner improves readability: extract helpers, return early, clear names. Gate: tests still pass (coverage not re-checked — refactoring may restructure without changing test surface).

At the B→C boundary — when the implementation is complete and the gate is green — the spec file is renamed with a `done-` prefix (`spec.md` → `done-spec.md`), so finished specs are visually distinguishable from open ones even if Phase C later fails or the session dies.

## Escalation

If rounds are exhausted (compilation failures, negotiation impasse, implementation failures, dispute limits), the loop escalates to you. Use `/loop-continue` to resume or `/loop-restart <phase>` to jump. `/loop-stop` explicitly escalates at any point.

## Works with Graphify

The loop pairs well with the [Graphify](https://github.com/pi-dev/pi-extensions/tree/main/graphify) extension for project knowledge graphs. Install Graphify separately and use `/graphify-build` before or after the loop for best results.

## Development

```bash
npm install
npm test          # unit tests (vitest, ~1600 tests, <20s)
npx tsc --noEmit  # type check
```

## License

[MIT](LICENSE)
