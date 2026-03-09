# AutopilotSBC

AutopilotSBC is a Chrome extension that helps you solve SBCs faster in the EA FC Ultimate Team Web App.

## What It Does

- Builds a valid squad for the current challenge.
- Repeats solves in one flow (`Multi`).
- Solves open challenges in a full SBC set (`Solve Entire Set`).
- Plans and solves several different SBCs in one saved run (`Sequence Solver`).
- Lets you control your player pool with simple toggles and rating limits.

## Main Features

- `Solve Squad` for one challenge.
- `Multi` for multiple runs of the same challenge.
- `Solve Entire Set` for set-level automation.
- `Sequence Solver` for cross-challenge and cross-set runs.
- Global defaults in EA app Settings under `SBC Solver`.
- Built-in `Changelog` notes that open once per version and can be reopened from Settings.

## Install (Chrome)

1. Download or clone this project.
2. Open `chrome://extensions`.
3. Turn on `Developer mode`.
4. Click `Load unpacked`.
5. Select the extension folder.
6. Open the EA FC Web App and refresh the page.

## How to Use

### Single Challenge

1. Open a challenge.
2. Click `Solve Squad`.
3. Review and submit.

### Multiple Runs

1. Open a challenge.
2. Click `Multi`.
3. Choose how many runs you want.
4. Start the run.

### Full Set

1. Open an SBC set page.
2. Click `Solve Entire Set`.
3. Select challenges and start.

### Sequence Plans

1. Open the SBC hub page.
2. Click `Sequence Solver`.
3. Add the SBCs you want to run in order.
4. Save the plan and start the sequence.

### Changelog

1. After a fresh install or update, the extension can show a `Changelog` popup once for that version.
2. You can reopen it later from EA app `Settings` under `SBC Solver`.

## Settings

- You can save global defaults in the EA app Settings tab under `SBC Solver`.
- You can also use challenge-specific or run-specific settings when needed.
- Typical controls:
  - Player rating range
  - Storage only
  - Exclude tradable
  - Exclude special
  - Include unassigned

## Recent Updates

- `v1.5`
  - Added `Sequence Solver` for planning and solving multiple different SBCs in one run.
- `v1.4`
  - Added a changelog popup for installs and updates.
- `v1.3`
  - Improved player lookup and squad applying speed.

## Disclaimer

AutopilotSBC is an unofficial experimental tool for the EA SPORTS FC Web App.
It is not affiliated with or endorsed by EA.
It is intended strictly for personal use.
Use this tool at your own risk.

## Privacy

- The extension uses Chrome storage for preferences.
- No external backend/server is required for solving.
