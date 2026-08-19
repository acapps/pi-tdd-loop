# CLAUDE.md (caveman)

pi-tdd-loop = public extension. 3 agents (Tester/Writer/Cleaner). Gated phases. Go/Java/TS.

I build it. I use it daily. Danger: my habits become "the product" by accident. This file = guard against that.

## ASK BEFORE EVERY CHANGE

Better for ANY user? Or just easier for me right now?

Only-my-setup change = scope creep. Not extension's job. Ask out loud, before code, not after.

## SMELL LIST - stop if you see:

- Hardcoded path/name/value = only works on my machine
- New flag/command born from ONE spec file, no other real use case
- Language logic that's really "how I structure my projects," not Go/Java/TS as ecosystems
- "While I'm in here" extra stuff, unrelated to the actual change
- Config that should live in dotfile/env var, not baked into repo
- Skipped general case because narrow case = faster ship. Flag it, don't hide it.

## IN-SCOPE CHECK

1. Fits shape? Phase 0 to Tester to Negotiate to Writer to Cleaner, gated. If not, say so, don't bend shape quietly.
2. Makes sense to stranger who only read README + SPEC.md?
3. About the language/toolchain itself (go test, Maven, vitest)? Not about my personal project layout?
4. Truly personal? Dotfile, local config, private script. NOT this repo.

## WHEN SCOPE CREEP SMELLS

Don't refuse silent. Don't build silent. Say:

"This solves your setup, not the extension. General option, keep local, or is there a bigger case?"

Then I decide. Point = choice on purpose, not by default.

## RULES

- SPEC.md / README.md = source of truth for what this IS. Change without doc update = drift signal.
- Spec conventions for /loop live in docs/spec-authoring.md (failure classes + template). New failure class seen in a review = doc update, same as a SPEC.md change.
- Every flag/command = API someone else must learn. Fewer, general beats many, narrow.
- Works-on-my-spec-files does not equal works. Test with non-me examples.
- When unsure: smaller, more general, more removable. Easy to grow later, hard to walk back.