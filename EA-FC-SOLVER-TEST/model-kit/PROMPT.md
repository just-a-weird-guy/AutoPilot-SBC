# Solver Build Prompt

You are given a frozen EA FC SBC benchmark pack. Build a Node.js solver module that reads one challenge plus the official player pool and returns one candidate squad.

## Deliverable

- Create `candidate/solver.js`
- Export `async function solveChallenge(input)`
- Input and output are defined in `solver-interface.md`
- The solver runs locally and offline against the files in this package

## Read In This Order

1. `solver-interface.md`
2. `challenge-schema.md`
3. `reference/player-schema.md`
4. `reference/ea-fc-sbc-rules.md`
5. `reference/constraint-normalization.md`
6. `datasets/challenges-v1.json`
7. `datasets/players-v1-flat.json`
8. `candidate-template/solver.js`

## What To Optimize

1. Solve as many challenges as possible
2. On solved challenges, prefer lower submitted average rating
3. Avoid wasteful squads such as unnecessary special cards, informs, tradables, high-rating anchors, and scarce items

## Important Implementation Facts

- `requirementsNormalized` is the structured source of truth for requirements
- `requirementsText` is only a human-readable explanation
- `challenge.squadSize` is the required number of selected players; not every challenge is a full 11-player squad
- some challenges in this corpus require 6, 7, or 8 players instead of 11
- `challenge.squadSlots` defines the official slot positions used for chemistry and position checks
- if a challenge requires fewer than 11 players, only the first `challenge.squadSize` official slots are part of the submission
- Position eligibility is player-specific: use `alternativePositionNames`, falling back to `preferredPositionName`
- submitted player ids must be unique
- duplicate `definitionId` values in the same squad are invalid
- chemistry is tied to slot placement, not just player selection
- when a challenge has a chemistry rule, your solver must return explicit slot assignments for the submitted players

## Suggested Build Approach

1. Pre-index the player pool by rating, league, nation, club, rarity, tradability, and eligible positions
2. Parse each challenge's `requirementsNormalized` into hard constraints and optimization preferences
3. Search for a legal set of `challenge.squadSize` players
4. When chemistry is required, search over slot placement as part of the solve
5. Return only `playerIds` for non-chemistry challenges, or return `playerIds` plus `slotAssignments` for chemistry challenges
6. Verify squad rating, chemistry, and identity constraints before returning

## Files That Matter Most

- `datasets/challenges-v1.json`
- `datasets/players-v1-flat.json`
- `solver-interface.md`
- `challenge-schema.md`
- `reference/ea-fc-sbc-rules.md`
