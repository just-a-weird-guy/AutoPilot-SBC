# EA FC SBC Rules

## Squad rating

The evaluator uses the same adjusted-average rating formula as the current solver.

For ratings `r1 ... rn`:
- plain average: `A = (r1 + ... + rn) / n`
- adjusted rating for each card:
  - if `ri <= A`, keep `ri`
  - if `ri > A`, use `2 * ri - A`
- adjusted average: `B = (adjusted_1 + ... + adjusted_n) / n`
- round `B` to 2 decimals
- final squad rating:
  - let `base = floor(B)`
  - if the decimal part of rounded `B` is at least `0.96`, squad rating is `base + 1`
  - otherwise squad rating is `base`

## Chemistry

The evaluator uses the same FC chemistry thresholds as the current solver:
- Club contribution thresholds: 2 / 4 / 7
- League contribution thresholds: 3 / 5 / 8
- Nation contribution thresholds: 2 / 5 / 8
- Each player chemistry is capped at 3

Position behavior:
- official challenge `squadSlots` are authoritative
- only the first `challenge.squadSize` official slots matter
- a player is on-position only if the slot position appears in the player's `alternativePositionNames`, or in `preferredPositionName` when no alternatives exist
- out-of-position players contribute 0 chemistry
- out-of-position players do not count toward chemistry thresholds for other players

Practical solver rule:
- when a challenge includes `chemistry_points`, solving means picking players and placing them into slots
- a set of players can satisfy all non-chemistry rules and still fail because the slot placement is wrong
- for chemistry challenges, the benchmark expects the solver to return the slot placement it is submitting

## Rarity semantics

- Generic `Rare` means base rare/non-special, not any special item
- `Rare or TOTW` is satisfied by:
  - rare non-special cards
  - TOTW / inform cards

## Penalty metrics

For solved squads, the evaluator computes the same unwanted-behavior metrics used by the benchmark:
- `ratingExcess`
- `maxRating`
- `highRatingScore`
- `highRatingCount`
- `identityBalancePenalty`
- `sumRating`
- `specialCount`
- `tradableCount`
- `scarcityPenalty`

Additional preservation fields are also reported:
- `informCount`
- `excessInforms`
- `excessSpecials`

Interpretation for solver design:
- legal is not enough; lower-rating and lower-waste squads rank better
- unnecessary special cards, informs, tradables, scarce items, and high-rating anchors are all negative behavior in benchmark scoring
