# opencode-audit v1

Handoff-first code audit. Ephemeral stealth models scan the codebase and write
structured investigation leads. A stronger paid model and a human verify the
leads and carry over fixes.

The scanner is a cheap context compressor. The handoff is the product.

## What it does

```text
repo → stealth scouts → quote check → second read → ranked handoff → main model → fixes
```

- Probe: stealth-only recall sweep. Raw candidate leads.
- Hunt: Probe plus a fresh-context replicator and reproduction recipes.
- Brief (post-A/B only): paid-model synthesis into a short final brief.

## What it never does

- Edit, execute, prove, or reproduce code.
- Run as a background daemon (one-shot jobs).
- Call a lead "confirmed" without execution.

## Output

```text
.audit/HANDOFF.md      human-readable ranked leads
.audit/handoff.json    machine-readable leads for the main model
.audit/manifest.json   what was scanned, skipped, and not covered
.audit/logs/           structured run events and funnel summaries
```

## Usage

```sh
npm install
npm test            # typecheck + unit tests (fake-model end-to-end included)
npm run compile     # build dist/

# Single-repo one-shot audit (needs a model transport):
export OPENROUTER_API_KEY=...
node dist/cli.js run <repo> --tier hunt --scope diff --models stealth/model-a,paid/model-b

# Read back the funnel and kill rates:
node dist/cli.js stats --dir <repo> --last 10

# Record downstream outcomes (feeds acceptance rate):
node dist/cli.js feedback AUD-XXXXXXXX fixed --dir <repo>
```

Model keys are `provider-id/model-id` pairs passed through to OpenRouter
(`--models` accepts a comma-separated list; Hunt prefers a second family for
the falsifier pass). Without `OPENROUTER_API_KEY`, `run` refuses — `stats`
and `feedback` work offline on existing `.audit/` dirs.

## Status

v1 skeleton. Implementation follows `~/.opencode/plan/stealth-audit-v1.md`
(spec) and `~/.opencode/plan/master-plan.md` (roadmap).
