# AutopilotSBC

AutopilotSBC is a Chrome extension for the EA SPORTS FC Ultimate Team Web App that adds local SBC solving and automation workflows.

It focuses on three goals:
- Generate valid squads quickly.
- Keep solver logic local in the browser extension runtime.
- Support repeat and set-level solve flows with practical controls.

## Table of Contents

- [Features](#features)
- [How It Works](#how-it-works)
- [Requirements](#requirements)
- [Installation](#installation)
- [Usage](#usage)
- [Solver Settings](#solver-settings)
- [Console Helper API](#console-helper-api)
- [Project Structure](#project-structure)
- [Troubleshooting](#troubleshooting)
- [Security and Scope](#security-and-scope)
- [Development](#development)

## Features

- Single challenge solve flow (`Solve Squad`).
- Multi-solve flow for repeated generation/submission (`Multi` / `Solve Multiple Times`).
- Set-level flow for solving all open challenges in a set (`Solve Entire Set`).
- Chemistry-aware solving with position validity checks.
- Global, challenge-local, and session-level solver settings.
- Local LP-based solver runtime with `glpk.js` + `glpk.wasm`.
- Built-in pacing/retry behavior for automation paths to reduce rate-limit issues.

## How It Works

1. `content-script.js` injects `page/ea-data-bridge.js` into the EA Web App page context.
2. The page bridge reads SBC/challenge/player data from EA app services and orchestrates UI actions.
3. Solver requests are bridged to the MV3 background service worker.
4. Solver modules compute valid squads and return results back to the page for apply/submit flows.

Core runtime modules:
- `page/ea-data-bridge.js`: page hooks, overlays, solver orchestration, settings, apply/submit.
- `background.js`: message bridge and solver execution entry.
- `solver/solver.js`: core solving and optimization.
- `solver/constraint-compiler.js`: requirement normalization to canonical constraints.
- `solver/chemistry.js`: chemistry/position logic.
- `solver/worker.js`: worker message handlers.

## Requirements

- Google Chrome (Manifest V3 extension support).
- EA SPORTS FC Ultimate Team Web App:
  - `https://www.ea.com/ea-sports-fc/ultimate-team/web-app/*`
  - `https://www.ea.com/*/ea-sports-fc/ultimate-team/web-app/*`

## Installation

1. Clone or download this repository.
2. Open Chrome and go to `chrome://extensions`.
3. Enable `Developer mode`.
4. Click `Load unpacked`.
5. Select this project folder (`ea-data-extension`).
6. Open the EA FC Web App and refresh the page.

## Usage

### Solve a Single Challenge

1. Open an SBC challenge in the EA Web App.
2. Click `Solve Squad`.
3. Review the generated squad.
4. Apply/submit from the in-app flow.

### Solve Multiple Times

1. Open an SBC challenge.
2. Click `Multi`.
3. Configure cycles/settings.
4. Start and monitor progress in the overlay.

### Solve an Entire Set

1. Open an SBC set overview.
2. Click `Solve Entire Set`.
3. Choose selection and cycle options.
4. Run and monitor per-challenge progress.

## Solver Settings

Settings precedence (highest to lowest):
1. Session settings
2. Challenge-local settings
3. Global settings
4. Hard defaults

Default pool/range settings:

| Setting | Default | Behavior |
| --- | --- | --- |
| `solver.ratingRange` | `{ ratingMin: 0, ratingMax: 99 }` | Restricts eligible player OVR range. |
| `solver.useUnassigned` | `true` | Allows duplicate/unassigned handling in pool filtering. |
| `solver.onlyStorage` | `false` | Restricts candidate pool to SBC storage items. |
| `solver.excludeTradable` | `true` | Excludes tradable players from candidate pool. |
| `solver.excludeSpecial` | `false` | Excludes special-card players from candidate pool. |

Global settings UI is injected under the EA app Settings tab as `SBC Solver`.

## Console Helper API

For debugging and inspection in browser devtools, these helpers are exposed on `window.eaData`:

```js
window.eaData.getSolverPayload({ ignoreLoaned: true });
window.eaData.getOpenChallengeRequirements();
window.eaData.getChallengeRequirements({ setId, challengeId });
window.eaData.getSolverPreferences();
window.eaData.getGlobalSolverSettings();
window.eaData.setGlobalSolverSettings(settings);
window.eaData.resetGlobalSolverSettings();
window.eaData.getChallengeSolverSettings(challengeId);
window.eaData.setChallengeSolverSettings(challengeId, settings);
window.eaData.getGlobalRatingRange();
window.eaData.getChallengeRatingRange(challengeId);
window.eaData.setGlobalRatingRange(range);
window.eaData.resetGlobalRatingRange();
```

## Project Structure

```text
.
|-- manifest.json
|-- content-script.js
|-- background.js
|-- page/
|   `-- ea-data-bridge.js
`-- solver/
    |-- solver.js
    |-- chemistry.js
    |-- constraint-compiler.js
    |-- worker.js
    |-- glpk.js
    `-- glpk.wasm
```

## Troubleshooting

- Extension not running:
  - Confirm it is enabled in `chrome://extensions`.
  - Reload the extension after code changes.
  - Refresh the EA Web App tab.
- Buttons not visible:
  - Ensure you are on supported EA FC Web App routes.
  - Wait for the app to fully load; hooks attach after EA classes are available.
- Solver returns no result:
  - Verify challenge requirements and available player pool constraints.
  - Check range/pool settings for over-restrictive filters.
- Multi/set automation interruptions:
  - EA API throttling can interrupt runs; retry after cooldown.
  - Use less aggressive settings/cycle counts when rate limits appear.

## Security and Scope

- Current extension permission: `storage` only.
- Solver runs locally inside extension runtime modules.
- This project automates actions in the EA FC Web App; use responsibly and at your own risk.

## Development

Typical local workflow:

1. Edit source files in this repository.
2. In `chrome://extensions`, click `Reload` on AutopilotSBC.
3. Refresh EA Web App and verify behavior in devtools console.

Recommended checks before commits:
- Validate key solve paths: single, multi, set.
- Test settings save/reset behavior (global + challenge-local).
- Confirm no regressions in chemistry-aware placement.

