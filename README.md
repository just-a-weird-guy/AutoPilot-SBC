# AutopilotSBC

AutopilotSBC is a browser extension for the EA SPORTS FC Ultimate Team Web App.

It started as a way to make SBC solving faster, less repetitive, and a lot more controllable.

Instead of rebuilding squads over and over by hand, the extension adds its own controls directly into the Web App so you can solve a single challenge, repeat a challenge multiple times, solve a full set, or run a saved multi-step sequence.

This repository is the extension itself.

## What It Does

AutopilotSBC has a few different solver flows depending on what you are trying to do:

- `Solve Squad` for a normal one-off challenge
- `Multi` for repeating the same SBC several times
- `Solve Entire Set` for working through an SBC group
- `Sequence Solver` for saved multi-SBC runs with ordered steps and loops

On top of that, it gives you real control over the player pool the solver is allowed to use. That includes things like rating limits, storage-only solving, tradable filtering, special-card handling, and local exclusions when you want one solve to behave differently from your defaults.

## Install

The main install source is now the Chrome Web Store.

### Chrome Web Store

Install AutopilotSBC from the [Chrome Web Store](https://chromewebstore.google.com/detail/autopilotsbc-fc26-sbc-sol/gkcjhdebgfhdbkecahbnpmcaobapcfbh?hl=en).

After installing, open the FC Web App and refresh the page if it was already open.

### Requirements

- Chrome or another Chromium-based browser
- access to the EA SPORTS FC Ultimate Team Web App

### Load unpacked for development

1. Clone or download this repository.
2. Open `chrome://extensions`.
3. Enable `Developer mode`.
4. Click `Load unpacked`.
5. Select this repo folder.
6. Open the FC Web App and refresh the page.

## Basic Usage

### Solve one challenge

1. Open an SBC challenge.
2. Click `Solve Squad`.
3. Review the result.
4. Apply and submit if it looks right.

### Repeat one challenge

1. Open a repeatable SBC.
2. Click `Multi`.
3. Pick the run count and options you want.
4. Start the run.

### Solve a full set

1. Open an SBC set page.
2. Click `Solve Entire Set`.
3. Choose which challenges should be included.
4. Start the run.

### Run a sequence

1. Open the SBC hub.
2. Click `Sequence Solver`.
3. Build or load a saved sequence.
4. Start the execution run.

## Settings and Controls

Most of the controls live inside the Web App under the extension's solver settings area.

Depending on the flow, you can work with:

- global defaults
- per-run overrides
- challenge-specific filters
- local league and nation exclusions
- rating limits and pool restrictions

The idea is that you should not have to keep changing your global setup just to make one challenge behave differently.

## Project Structure

If you want to poke around in the code, these are the main places to start:

- [manifest.json](manifest.json)  
  extension metadata, permissions, and injected assets
- [background.js](background.js)  
  background/service worker logic
- [content-script.js](content-script.js)  
  bootstraps the extension into the Web App
- [page/ea-data-bridge.js](page/ea-data-bridge.js)  
  main injected page logic, UI wiring, automation, and app hooks
- [page/ea-data-bridge.css](page/ea-data-bridge.css)  
  extension UI stylesheet
- `solver/`  
  solver logic, chemistry helpers, worker entry, and GLPK assets
- `data/`  
  extension data files such as the built-in changelog
- `icons/`  
  extension icons and packaged assets

## Contributing

Feature ideas, feature requests, and pull requests are all welcome here.

If you have an idea that would make the extension better, open an issue for it. If you want to build it yourself, open a PR.

Good contribution areas:

- solver improvements
- new features or workflow ideas
- smarter player-pool handling
- UI cleanup and consistency
- regression coverage through replays
- stability when EA changes Web App behavior

If you open an issue or PR, it helps a lot if you include:

- a clear description of the idea or problem
- the user-facing effect
- screenshots for UI changes
- logs if the issue is solve/fetch/apply related
- any replay or manual validation you ran

Small, focused pull requests are easier to review and safer to merge than large mixed ones.

If you are not sure whether something fits the direction of the project, open the issue anyway. I would rather have people throw ideas out there than hold back because they assume it is out of scope.

If you have been enjoying my work and would like to support what I do, you can find me over on [Ko-fi](https://ko-fi.com/P5P5YOUU7).

## A Few Important Notes

- This extension is tightly coupled to the EA FC Web App DOM and controllers, so upstream UI changes can break hooks or selectors.
- The page bridge is still a very large file, and I am cleaning it up over time.

## Privacy

- preferences are stored locally in extension/browser storage
- solving does not require a hosted backend
- the extension operates against your active Web App session in the browser

## Disclaimer

This is an unofficial automation tool for the EA SPORTS FC Web App.

It is not affiliated with or endorsed by EA.

Use it at your own risk.

## License

This project is licensed under the GNU General Public License v3.0.
