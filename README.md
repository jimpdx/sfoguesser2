# KSFO Ground Trainer

A browser trainer for the gates and ramp spots at San Francisco International, built for VATSIM ZOA ground and ramp controllers. It replaces the older [Airport Gates Guesser](https://dreamnid.github.io/airport-gates-guesser/public/sfo.html).

The map is drawn the way the ASDE-X display shows SFO: rotated 27.9 degrees so runways 1/19 run straight up and down and 10/28 run straight across.

## Modes

- **Learn**: every gate and spot on the map, colored by boarding area. Turn labels off to quiz yourself: tap a marker to reveal it, tap again to hide it.
- **Quick 10**: ten gates with no repeats, scored as a percent with a time. A miss shows the gate you clicked in red and the right one in green before moving on.
- **Streak**: keep going until your first miss. The clock stops at your last correct answer. Best streaks are saved in the browser for each set of areas.
- **LEADERBOARD**: an arcade-style top 10 for Quick 10 and for Streak, one board for each set of areas. If a run makes the board, you type a name of up to 6 letters, digits or _ (like ZOA_JT). Quick 10 ranks by percent, then time; Streak by count, then time; earlier posts win exact ties.
- **Base map**: a diagram in the style of the airport chart (black field, gray ramps, white terminals, runways) or a March 2026 satellite photo. Runway designators show on both.
- **Taxiways**: an on/off toggle that draws taxiway centerlines in yellow, with a sign-style letter for every named taxiway in view (A, B, D, E, K, Q, T and the rest).
- **Areas**: limit any mode to some boarding areas (A to G) or to the spots only.

To link to one part of the airport, add `?view=x0,y0,x1,y1` to the URL (meters in the map's rotated frame, x to the right, y down; for example `?view=-650,-800,250,-520` frames the north exits).

Drag to pan, and scroll or pinch to zoom. Keys: `+`, `-`, `0` for the home view, `L` to toggle labels in Learn mode, `T` to toggle taxiways, and Space or Enter to continue after a miss.

## What's on the map

All gates and spots come from the Jeppesen 10-9B dated 23 OCT 26 (effective 29 Oct).

- **115 gates**: A1-A15, B1-B27, C1 and C3-C11, D1, D3-D12 and D14-D16, E1-E13, F1-F22, G1-G14.
- **No separate sub-positions**: the lettered ones (A4R, A4T, B5S, D8V, D12A, E10U, F3A, G12S and the rest) are folded into their base gate, since controllers call them by the base gate ("Alpha Four").
- **Not included**: C2 (gone from the current chart), D2 (closed when Southwest moved into Terminal 2: jet bridge removed, the stand now holds equipment) and the remote stands G103-G105, Plot 2, Plot 6 and Plot 9.
- **18 spots**: 1, 2, 3, 4, 4A, 5, 5A, 5B, 6, 6A, 6B, 7, 7A, 7B, 8, 9, 10, 11.

Where each point came from:

- **106 gates**: the stop end of the stand lead-in line mapped in OpenStreetMap.
- **2 gates**: A4 and B8 have no lead-in line in OSM, so A4 uses its OSM gate point and B8 its jet bridge tip.
- **7 gates placed by hand**:
  - G12 and G14, wrapped around the G13 widebody stand.
  - E1 and F1-F4, from the chart labels. These are in the Terminal 3 West construction zone in the satellite photo.
- **16 spots**: placed on the blue painted boxes visible in the satellite photo. The 5s and 6s are spread to the same spacing as the 7s (about 27 m apart instead of 21 m) so they're easier to tell apart.
- **Spots 10 and 11**: follow the chart. Plot 9 has been rebuilt since the photo was taken, so these two are worth a check by someone who knows the current layout.

The `src` field in `data/sfo/gates.json` records each point's source.

## Running it

It's a static site with no build step and no dependencies. Serve the folder over http (the page loads JSON, so opening the file directly won't work):

```
python -I tools/serve.py
```

Then open http://127.0.0.1:8000. This server turns browser caching off, so a normal reload always picks up your edits. Plain `python -m http.server` works too, but browsers may then keep an old `app.js` until you force-reload with Ctrl+Shift+R. For hosting, turn on GitHub Pages for the repository root.

## Leaderboard

Scores live in Firestore, in a Firebase project of their own. The page talks to Firestore's REST API with plain `fetch`, so there's still no library to load, and the site stays on GitHub Pages. With no project set in `data/sfo/airport.json` (`leaderboard.projectId`), the board is hidden and everything else works as before.

How scores are kept honest (`firestore.rules`):

- Starting a challenge creates a run record. Firestore stamps its start and end times itself, so the page can't fake them.
- A score is posted together with marking its run used, so each run posts at most once.
- The posted time has to fit the time Firestore measured for that run, and can't beat the floor the game sets: each correct answer holds the screen for 2 seconds.
- Names must be 1 to 6 of A-Z, 0-9 and _, with a short list of rude words refused.
- Nobody can edit a score, and only admins can delete one.

Someone determined could still script a run that waits out the real time, so treat the board as a friendly one.

### Admin view

Add `?admin` to the URL and switch to Quick 10 or Streak. An Admin box under the board offers sign-in with Google or GitHub. Signed in as an admin, each score gets an × to delete it, plus "Clear this board" and "Clear all boards" (which asks you to type CLEAR). Firebase's sign-in library loads only in this view.

The sign-in buttons come from `leaderboard.signIn` in `data/sfo/airport.json` (`google`, `github`); each one also has to be turned on in the Firebase console under Authentication, Sign-in method. GitHub needs an OAuth App (GitHub, Settings, Developer settings, OAuth Apps) whose callback or redirect URL is `https://ksfo-ground-trainer.firebaseapp.com/__/auth/handler`; its Client ID and client secret go into Firebase's GitHub panel, never into this repo. Firebase allows one account per email by default, so someone who signed in with Google can't then use GitHub with the same email; each admin sticks to one method.

Admins are listed in Firestore, not in this repo: one document per admin in the `admins` collection, named by that account's Firebase user ID (any fields, such as a name). The rules check that list on every delete, so finding `?admin` gets a stranger nothing.

- **Adding an admin**: they open `?admin`, sign in, and the page shows their user ID with a copy button. In the Firebase console, go to Firestore Database, open `admins` (or start that collection), and add a document with that ID.
- **Removing an admin**: delete their document there.
- **One-time setup**: in the Firebase console, turn on Google (and GitHub, if listed) under Authentication, Sign-in method, and add the site's domain (for example `jimpdx.github.io`) under Authentication, Settings, Authorized domains. `localhost` is allowed already, so test locally at http://localhost:8000/?admin rather than 127.0.0.1.

The Firebase console can always delete scores directly too: Firestore Database, `airports/KSFO/scores`.

Setting up a project (one time):

1. `firebase login`, then create a project, turn on Firestore and register a web app (console or CLI).
2. Put the project ID and the web app's API key in `data/sfo/airport.json` under `leaderboard`. Firebase web keys are meant to be public; the rules protect the data.
3. Deploy the rules and the index: `firebase deploy --only firestore --project <project-id>`.

To hand the board over, add the new owner to the Firebase project (Project settings, Users and permissions).

Testing locally: `firebase emulators:start --only firestore --project demo-ksfo` runs a throwaway Firestore on port 8085 with the same rules. Open http://127.0.0.1:8000/?emulator to play against it; scores vanish when the emulator stops.

## Updating gates

When SFO renumbers or moves gates:

1. Open `index.html?edit`. Drag markers to their new spots; moved ones get a yellow ring.
2. Click "Download gates.json", replace `data/sfo/gates.json` with it, and commit.

To add or remove a gate, edit `data/sfo/gates.json` by hand (each point has an id, kind, area, lat and lon), then fine-tune its position in edit mode.

Labels sit above each marker. Where neighbors crowd that space, a point can carry `"label": "left"` or `"label": "right"` (F20-F22 use left; spots 5, 5A and 5B use right).

Edit mode can lay a new chart over the map as a placement guide. Take a screenshot of the new 10-9B, read two longitude ticks and two latitude ticks off its border in pixels, and run:

```
python -I tools/reference_overlay.py chart.png --lon 122.5=-122.398333 --lon 1353.5=-122.380 --lat 147.5=37.621667 --lat 1419.5=37.606667 --crop 29,96,1384,1558
```

That writes `.cache/reference.png`, which only exists on your machine (the chart is Jeppesen's copyright and is never committed). Tick "Reference chart overlay" in edit mode to see it.

## Rebuilding the base maps

These need Python 3 with Pillow. Outputs go to `data/sfo/`; downloads are cached in `.cache/` (gitignored).

| Script | Does |
|---|---|
| `tools/fetch_osm.py` | Downloads SFO airfield geometry from OpenStreetMap |
| `tools/build_chart.py` | Draws `chart.svg` from that geometry plus `tools/ramp_outline.json`, and writes `runways.json` (thresholds and designators) and `taxiways.json` (centerlines and where each letter goes) |
| `tools/build_imagery.py` | Downloads Esri World Imagery tiles and builds the rotated `satellite.webp` |
| `tools/seed_gates.py` | One-time: seeds `gates.json` from OSM plus hand placements (refuses to overwrite) |

After editing anything in `tools/build_chart.py`, run `python -I tools/build_chart.py` to regenerate `data/sfo/chart.svg`, `runways.json` and `taxiways.json`; the page only reads those generated files.

Taxiway letters are placed automatically, except for rows lined up by hand in `ALIGNED` at the top of the taxiway section of `tools/build_chart.py`: Q, K, D, T and E across the exits between runway 28L and taxiway B, and F, W, G, H, M and M1 east of taxiway B, halfway to runway 1L. Add a row there to line up others. `MOVED` in the same file shifts single letters (the B between T and E), and `DROP_WAYS` leaves OSM taxiways off the diagram and the overlay (a curve onto F at B that OSM calls J).

The spot lanes are drawn tidier than OpenStreetMap has them (`LANE_LENGTHS`): the 5, 6 and 7 lanes each run 200 m in from taxiway A and pass through their spot markers, and lanes 8 and 9 run 287.5 m straight on from B4 and B5. Taxilanes M3, M4 and M5 are trimmed so their north ends line up (`M_LANES`).

The rotated frame (center, angle, bounds) lives in `data/sfo/airport.json`. `tools/common.py` and `app.js` share the projection math, so keep the two in sync if you change it.

## Credits

- Chart drawing: map data from [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors, ODbL.
- Satellite: Esri World Imagery (Vantor, captured 19 March 2026), for non-commercial use.
- Gate and spot list checked against the Jeppesen 10-9B (not included).

For flight simulation only. Not for real-world navigation.
