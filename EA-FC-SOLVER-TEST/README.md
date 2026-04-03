# EA-FC-SOLVER-TEST

EA-FC-SOLVER-TEST is a frozen benchmark kit for EA FC SBC solver generation.

It has two distinct surfaces:
- `model-kit/`: the exact package you hand to a model that must build a solver
- `evaluator/`: the official runner, validator, scorer, and frozen baseline outputs

If you are generating a solver, start at `model-kit/PROMPT.md`.
If you are benchmarking a solver, start at `evaluator/README.md`.

## Official v1 corpus

- Challenges: `211`
- Players in flattened official pool: `2025`
- Challenge source: `model-kit/datasets/challenges-v1.json`
- Player source: `model-kit/datasets/players-v1-flat.json`
