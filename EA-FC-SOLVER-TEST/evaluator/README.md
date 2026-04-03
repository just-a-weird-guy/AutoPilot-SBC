# Evaluator

Scripts:
- `run-benchmark.mjs`: runs a candidate solver over the full corpus
- `validate-solution.mjs`: validates one solution against one challenge
- `score-solution.mjs`: emits legality plus solved-squad metrics for one solution

The evaluator is authoritative:
- candidate self-reported validity is ignored
- duplicate player ids are rejected
- duplicate `definitionId` values in a squad are rejected
- the official challenge `squadSlots` are used for chemistry and position checks
- chemistry challenges require candidate-provided `slotAssignments`
