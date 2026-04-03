# Challenge Schema

Each entry in `datasets/challenges-v1.json` is one SBC challenge record.

Fields that matter for solving:
- `challengeId`: stable challenge identifier
- `setName`, `challengeName`: descriptive names only
- `squadSize`: required number of selected players; some challenges are smaller than 11
- `formationName`, `formationCode`: descriptive formation metadata
- `squadSlots`: official slot positions used for chemistry and position checks
- `requirementsText`: human-readable requirement lines
- `requirementsNormalized`: machine-readable requirement rules used by the evaluator

`squadSlots` entries look like:

```ts
type SquadSlot = {
  slotIndex: number;
  positionName: string;
  slotId?: string;
};
```

Important slot rule:
- use only the first `challenge.squadSize` official slots for assignment and chemistry
- `squadSize` is authoritative for submission size
- when chemistry matters, slot placement over those official slots matters too

`requirementsNormalized` entries look like:

```ts
type NormalizedRule = {
  type: string;
  op: "min" | "max" | "exact";
  count: number | null;
  value: Array<string | number>;
  label: string;
};
```

Practical reading rule:
- `type` tells you what is being constrained
- `op` tells you whether the bound is minimum, maximum, or exact
- `count` is usually the player count for player-specific rules
- `value[0]` usually carries the numeric threshold or the target identity id
- `label` is a readable fallback if you need to log or debug the rule
