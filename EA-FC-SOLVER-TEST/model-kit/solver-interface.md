# Solver Interface

Candidate file:
- `candidate/solver.js`

Required export:

```js
export async function solveChallenge(input) {}
```

The default export may also be the solver function.

## Input

```ts
type SolverInput = {
  version: "ea-fc-solver-test-v1";
  challenge: ChallengeRecord;
  players: Player[];
  metadata: {
    challengeIndex: number;
    challengeCount: number;
  };
};
```

See `challenge-schema.md` and `reference/player-schema.md` for the important field definitions.

## Output

Return either:
- an array of player ids
- or an object with this shape

```ts
type SolverOutput = {
  playerIds?: Array<string | number>;
  slotAssignments?: Array<string | number> | Array<{ slotIndex: number; playerId: string | number }>;
  meta?: Record<string, unknown>;
};
```

Notes:
- `playerIds` must contain exactly the selected squad members
- use `challenge.squadSize` as the required squad length
- if `challenge.squadSlots` contains more slots than `challenge.squadSize`, only the first `challenge.squadSize` official slots matter
- `slotAssignments` is required when the challenge includes a chemistry rule
- `slotAssignments` may be omitted only when chemistry is not relevant to the challenge
- ordered `slotAssignments` are interpreted by slot index from `0` to `challenge.squadSize - 1`
- If `slotAssignments` is provided, it must match the same selected squad exactly
- The evaluator ignores any self-reported validity or scoring fields
