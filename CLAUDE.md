# BottleCapture: project context for Claude Code

Read this first. It hands over the state of the project from an earlier Claude.ai conversation.

## The project
- Master's computer-vision project (OTH Amberg-Weiden): predict the **grams of water in a bottle from one photo**.
- Four bottle types: B01 Kondrauer (glass, 0.7 L), B02 Stephanie Brunnen Labertaler Mild (glass), B03 Stephanie Brunnen Labertaler Medium (PET), B04 Staatl. Fachingen (glass, 0.75 L).
- The professor has a separate validation set ("Data given by professor (Validation Data)"). **Never train or tune on it.** Score on it at most once, at the very end.
- Two people collect data with the web app: the repo owner and a partner, into one shared Google Drive folder.

## This repo
- `dist/`: the BottleCapture web app (plain ES modules, no build step). Deployed to GitHub Pages by `.github/workflows/pages.yml`, which runs `npm test` and stamps module URLs with the commit ID.
  - Photos and labels are stored per device in IndexedDB and synced to Google Drive (full `drive` scope, shared dataset folder, delete markers via `appProperties.bottlecaptureDeleted`).
  - Protocol 2 (current): free random fills per session (`F01`, `F02`…), about 8 tagged photos per fill (spot, label side, camera height, distance, water-surface visibility). New-fill suggestions aim at the biggest gaps and avoid amounts within 10 g of existing fills.
  - Each photo has a JSON sidecar with `water_mass_g`, `fill_id`, `session_id`, `bottle_id`, `split`, tags. Filenames like `B02_I01_S01_d10b6bb3_F02_P01.jpg`.
  - Tests: `npm test` (Node, fake IndexedDB, mocked Drive). Keep them passing.
- `ml/`: the model.
  - `train.py`: fine-tunes ImageNet EfficientNet-B0 or ConvNeXt-Tiny to output grams; pads to square (never crops the bottle); grouped CV that holds out **whole fills**; `--probe` = frozen network + ridge regression; `--exclude-fill` to drop a bad fill.
  - `evaluate.py`: predicts a folder of photos, optional one-time scoring.
  - `run_on_workstation.sh`: venv + background training on the OTH GPU machines (ki-029…032, RTX 2080 8 GB). Logs to `~/bottle_runs/train.log`.

## Where things stand (11 Nov 2026)
- Dataset copy on ki-029: `~/BottleCapture Dataset` (copied 9 Nov: 120 photos, all bottle **B02**, 12 fills). The app now shows 13 fills / 134 photos for B02, so recopy the folder before the next run.
- Findings on the 9 Nov data:
  - Fills: 0, 40, 65, 145, 180, 195, 225, 270, 305, 350, 435, 480 g (later also 100 g). Biggest gap 350–435 g; nothing at full (500 g).
  - Good variety of spots, label sides, heights and distances. Water line hidden or partial in about 44% of photos (clear glass, clear water).
  - S01 F01 is labelled 0 g; full-resolution crops suggest the bottle really was empty, so it is kept.
  - Every fill after F01 equals its suggested target exactly; worth confirming the readings were real.
  - S01 spans two days and two places (5 Nov home, 9 Nov office) but all photos say "Creative space". All splits are "train"; no validation sessions yet. All daylight.
  - Photos: 96 from a OnePlus Android (3072×4096), 24 from an iPhone (3024×4032).
- Results so far (whole fills held out):
  - Weight-free baseline (HOG + colour profile): ~128 g MAE vs 117.5 g for always guessing the average.
  - Fine-tuned EfficientNet-B0 on ki-029: **143.5 g MAE per photo** (fill average 139.3 g), worse than guessing. Training loss fell to ~0.1, so it memorises fills. Cause: 12 fills of one bottle is far too little data.
  - Next planned check: `python train.py --data "$HOME/BottleCapture Dataset" --cv 5 --probe` (and with `--arch convnext_tiny`).

## Next steps agreed
1. Collect all four bottles, about 40–60 fills per bottle, ~8 varied photos per fill.
2. Add validation sessions (another day/room, 10–12 fills per bottle, split = validation).
3. Fill gaps (350–435 g, near full), add evening/lamp lighting, start a new session per day/place with the right background.
4. Re-run grouped CV and the linear probe as data grows; only then compare models.

## Working rules
- Ask before deleting files or installing software system-wide (shared lab machine; follow `/share/labor/Laborordnung.md`).
- Explain results in plain language, short sentences; separate what was measured from what is assumed.
- Do not commit dataset photos to git.
