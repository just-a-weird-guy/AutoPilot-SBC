# Player Schema

Official evaluation uses `datasets/players-v1-flat.json`.

Core fields for solving:
- `id`: unique owned-card id used in solver output
- `definitionId`: item definition id; duplicate definitions in one squad are invalid
- `rating`: face rating used for squad rating and average-rating comparison
- `leagueId`, `nationId`, `teamId`: chemistry and identity constraints
- `rarityName`, `isSpecial`, `isTotw`, `isEvolution`: rarity and special-card logic
- `isTradeable`, `isUntradeable`: tradability rules and penalty behavior
- `owners`: available for ownership-based rules
- `preferredPositionName`, `alternativePositionNames`: official position eligibility source

Position legality rule:
- Use `alternativePositionNames` when present
- Otherwise fall back to `preferredPositionName`
- There is no separate global position mapping table in this benchmark

Available but usually lower priority:
- `name`: display only
- `pile`, `isStorage`, `isDuplicate`: inventory state
- `playStyle`, `upgrades`, `isEnrolledInAcademy`: extra card metadata
