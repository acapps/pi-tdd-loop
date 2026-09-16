# Changelog

All notable changes to pi-tdd-loop are documented here.

## 0.1.0 — Initial release

### Core loop
- Adversarial 3-agent TDD loop: Tester → Negotiate → Writer → Cleaner
- Gated phase transitions: compile, test, coverage
- Dispute mechanism: Writer can dispute tests, Tester defends or concedes
- Phase 0: baseline test suite check + spec review (ambiguity detection)
- Escalation on round exhaustion, dispute limits, or impasse
- State persistence via session JSONL (`loop-state` custom entries)

### Language support
- **Go** — `go build`, `go test -json`, `go test -cover`
- **Java (Maven)** — `mvn compile`, `mvn test`, `mvn jacoco:report`
- **TypeScript** — `npx tsc --noEmit`, `npx vitest run`
- Auto-detection from project files (`go.mod`, `pom.xml`, `package.json`)

### Commands
- `/loop` — start the loop (`--language`, `--coverage`, `--timeout`, `--branch`, `--no-auto-approve`)
- `/loop-approve` — approve Phase 0 review
- `/loop-status` — show current state
- `/loop-continue` — resume after escalation
- `/loop-restart <phase>` — jump to a specific phase
- `/loop-debug` — show debug entries; `--log-bug` writes a bug spec
- `/loop-patch <spec>` — mid-loop spec correction
- `/loop-decompose <spec>` — split a large spec into sub-specs
- `/loop-stop` — explicit escalation
- `/loop-cancel` — stop and return to idle
- `/spec` — one-shot spec author (stateless)

### Tools (agent-facing)
- `negotiate_propose` — propose implementation approach or file/concede dispute
- `negotiate_review` — approve or give feedback on a proposal

### Features
- Git branch workflow: `--branch` creates a feature branch, merges back on completion
- Project config: `loop.config.json` for per-project defaults
- Phase 0 auto-approve: clean review auto-advances (opt-out with `--no-auto-approve`)
- Golden project workspace: spec-path-derived workspace root, write enforcement
- Spec archival: `done-` prefix at B→C boundary
- Loop breaker: repeated tool-call detection (3× same call → notice)
- Non-interactive runner: `PI_LOOP_RUNNER=1` + status file + `bin/run-loop.sh`

### Bug fixes (notable)
- Dispute state: 6 flat flags → single `DisputeState` object (reload-safe)
- Gate in-flight lock: prevents duplicate gate runs on duplicate settles
- `justTransitioned` flag: cleared on dispute file/concede (prevents gate skip)
- Agree detection: filler-stripping regex handles LLM verbosity ("I agree", "yes, agreed")
- Dual-path consolidation: `deliverAdvancePrompt` shared by both advance paths
- `--language` validation at parse time (not commit time)
- Dispute review tool access: reviewer gets read/bash during `"in-review"`
- Single commit point: state persisted once per settle, not mid-handler
- Process boundary mocking in tests (no real toolchain in unit suite)

### Architecture
- 50+ source modules across 4 layers (commands, tools, events, infrastructure)
- ~1650 unit tests, all mocking the process boundary
- 127 golden scenario tests (mock-based phase/round progression)
- Registration surface test (SHA-256 hash of `index.ts`)
