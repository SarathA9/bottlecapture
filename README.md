# BottleCapture — Collection Studio

A private, mobile-first web application for collecting a four-bottle water-mass dataset. Browser-native ES modules, IndexedDB, Google Identity Services, and Google Drive v3. No LLM API, backend photo storage, or prediction model is included.

## Use
Open the published HTTPS site on your phone. Settings contains the one-time Google OAuth setup. Create a session (bottle, physical bottle ID, split, tare, full reference). Tap **Weigh a new fill**: the app suggests a random amount to pour, you weigh it and enter the balance reading. Then take about 8 photos (4 for validation/holdout) in different spots, following the shot prompt, and tag each photo in a few taps. Pour water in or out and weigh again for the next fill.

Photos can be taken with the phone camera one at a time, with the live camera, or shot in bulk with the phone camera app and imported together as one fill. Save commits original JPEG bytes (or converts other formats to JPEG) to IndexedDB, then queues Drive upload when connected.

Drive creates BottleCapture Dataset / bottle / physical instance / unique session / fill (F01, F02…). Each JPEG has a JSON sidecar with its measured grams and tags. Local ZIP export contains images/, labels.csv and index.json. No local records are auto-deleted.

## Google setup
1. Create your own Google Cloud project and enable Google Drive API.
2. Configure Google Auth Platform consent. For an external testing app, add your own account as a test user.
3. Create an OAuth web client. Authorize the exact published site origin as a JavaScript origin.
4. Paste its public client ID into the app's Settings. Never supply a client secret.
5. Connect, approve drive.file access, and test a pilot JPEG and JSON sidecar.

Only `drive.file` scope is requested. The login is kept in this browser's localStorage, so it survives closing the tab or the browser, until it expires or you tap Disconnect. This is separate from ChatGPT's Google Drive connector. Google or managed-account policy may require extra setup.

## Reliability
IndexedDB saves are committed before showing success. Unique slot keys prevent overwrite. Drive IDs are generated and persisted before file creation; retries reuse them. A photo is marked synced only after both JPEG and JSON exist, match their expected byte size and are not in Trash. This checks byte size, not a cryptographic digest. Sync is serialised with Web Locks when available; use one tab. Failed sync stays pending and can be retried. New photos during a sync are drained before it completes. Do not move/delete cloud records during collection.

Safari can pause uploads when backgrounded. Keep the app open until sync completes. Local browser storage can be evicted or cleared. There is no service-worker offline cold start in this version: open online, then temporary disconnection can be tolerated while the page stays loaded. Session measurement is reconfirmed when resuming. Native camera-picker activity is exempt from the pause reset.

Images are only manually reviewed: the app cannot verify mass, focus, identity, angle, or hidden water level. A live video-frame capture may be lower resolution than the iPhone's native still camera. Use the native camera input where possible. Check EXIF orientation in your model loader. Never train on the bundled generated framing illustrations.

## Collection (protocol 2)
Built to match the professor's validation photos: every image is taken in a different spot of the creative space (DC 3rd floor), with the bottle turned to any side, at varied heights and distances, sometimes held in a hand, with continuous masses from near empty to full.

- **Fills, not levels.** Each fill is one balance reading. The suggested pour comes from the least-covered tenth of the range for that bottle and split (random within it), so masses spread evenly and never sit on 10% steps.
- **Many spots per fill.** A rotating 8-step shot plan prompts a new spot, label side (front/side/back), camera height (low/bottle height/above) and distance. Each fill starts at a different plan step.
- **Tags per photo.** spot, label_facing, camera_height, distance, visibility, plus fill_id, target_water_g and protocol in labels.csv. Use them for error analysis, not as model inputs.
- **Goal per bottle:** about 60 training fills × 8 photos, 12 validation and 12 holdout fills × 4 photos on other days. Use 2–3 physical bottles per type.
- **Leakage.** Group splits by fill_id (or session). All photos of one fill share one water level.

Sessions created before protocol 2 keep the old 11-level, fixed-view workflow and filenames (L03_A_01).

## Verification
`npm ci && npm test` runs calculations, naming, split validation, ZIP CRC, IndexedDB and mocked Drive retry tests. Browser QA verified creation, 11 levels, 224.7 g measured vs 225 g target, photo review, Save & Next, stored photo after reload and ZIP preparation. Live iPhone camera, iOS share/download completion, Google consent and actual cloud upload are not device-tested. Cloud browser download automation timed out after ZIP preparation; ZIP creation/contents passed a separate Python check.

## Files
- dist/core.js: dataset rules and labels
- dist/db.js: transactional local storage
- dist/drive.js: OAuth and resumable application-level upload queue
- dist/zip.js: dependency-free stored ZIP writer
- dist/app.js: UI and capture workflow
- dist/style.css: responsive layout

## Development
Serve dist/ through HTTPS for camera and OAuth. Set the local origin in your Google OAuth client if testing sign-in locally. Static deployment; no runtime secrets. Test records in preview storage are not included in the published app.

## Resume and reset
Continue photos opens the first incomplete fill and next missing view after confirming the measured mass. Reset session archives the previous attempt and creates a fresh empty attempt with the same setup and references. Archived photos remain available for export, and existing Drive files remain unchanged. New attempts use separate Drive session folders.

## Delete a session
Open the session and tap Delete session, then confirm. The session, its fill measurements and its photos are removed from this device. If any photos reached Google Drive, the session's Drive folder is moved to Drive Trash (restorable for 30 days). If Drive is not connected at that moment, the folder is queued and moved to Trash at the next sync. Deletion waits for any running upload, so an upload cannot recreate the deleted files.

## Retake from the Dataset view
In Dataset, open a photo and tap Retake this photo. The app opens the same bottle, level and view. Reweigh the bottle first. If the reading matches the saved fill within one scale step, the retake keeps that label. If it differs, you can confirm the new reading, and only the retaken photo gets the new measured mass. Nothing is deleted until you save the retake. On save, the photo is replaced locally under the same filename, the old Drive JPEG and JSON are queued for Drive Trash, and the new pair is uploaded. Archived attempts are read-only.

## Live camera
The live camera fills the screen and sizes the preview to the real video, so the guide frame sits on the image. It asks for the full 4:3 sensor and, if an upright phone returns a sideways stream, asks again for a portrait stream. The live label shows the actual stream resolution.

## Use on several devices (phone + laptop)
Each browser keeps its own local copy. To see phone photos on the laptop, use the same Google account **and the same OAuth client ID** on both. Google's `drive.file` access only lets an app see files created with its own Cloud project, so a different client ID from another project cannot see the phone's uploads.

When Drive is connected, the app loads the shared dataset on start and after Connect. You can also tap Load from Drive in Dataset or Settings. It downloads sessions and photos uploaded by other devices, replaces photos retaken elsewhere, and removes photos whose Drive files were deleted elsewhere. Photos this device has not uploaded yet are never removed. Every device reuses the existing BottleCapture Dataset folders instead of creating duplicates. Archived-attempt status is not stored on Drive, so an archived attempt appears as a normal session on other devices.

## Capture with a friend (two Google accounts, one central dataset)
1. In Google Cloud Console → Google Auth Platform → Audience, add the friend's Google email as a test user.
2. In Google Drive, share the "BottleCapture Dataset" folder with the friend as Editor.
3. The friend opens the site, pastes the same OAuth client ID, and connects with his own account.

Both of you work on one dataset, like two people on one git branch. Either person can start sessions, add photos to any session, retake any photo and delete any session. Each device pushes its changes when it syncs and pulls everyone else's changes on open, every 2 minutes, after each sync, and when you return to the tab (never in the middle of capturing).

How it works:
- The app requests full Drive access (`drive` scope), because `drive.file` cannot see files another account created. It only reads and writes inside the dataset folder. A folder shared with you is found automatically; Settings also accepts a pasted folder link.
- In a shared My Drive folder only a file's owner can move it to Trash. So deletes and retakes first mark the old file or folder as deleted (`appProperties.bottlecaptureDeleted`), which every device treats as gone. The owner's device moves marked items to Drive Trash at its next check, where they stay restorable for 30 days.
- If both people save the same photo slot, the newest upload wins on every device.
- Photos a device has not uploaded yet are never removed by a pull. If their session was deleted elsewhere, they stay on that device and are not uploaded; export or delete them there.
- The friend's photos are stored in your folder but count against his Google storage.
- Archived-attempt status (Reset session) and fill measurements without photos are not shared.
- Everyone must reconnect once after the switch to full Drive access.

## Staying connected
Google gives a browser-only app a login that lasts about 1 hour. A longer login needs a small server that holds a client secret, which this app deliberately does not have. So the app does the most that is possible without one:
- The login survives closing the tab or the browser (localStorage) until it expires. Any script on this site's origin could read it, so use the app only on your own devices, and tap Disconnect on a shared phone.
- Every 2 minutes, and when you return to the app, it checks whether the login ends within 5 minutes. If so, it asks Google for a fresh one quietly (`prompt: none`). That works while you are still signed in to Google in this browser and the browser allows it.
- If the quiet renewal is blocked (iPhone Safari often does), the top-right badge turns into **Tap to reconnect Drive**. One tap reconnects without an account chooser, then loads and uploads what is waiting.
- Photos are always saved on the device first, so an expired login never loses photos. The badge shows how many are waiting.
- Disconnect turns this off until you connect again.
