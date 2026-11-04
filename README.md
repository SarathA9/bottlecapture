# BottleCapture — Collection Studio

A private, mobile-first web application for collecting a four-bottle water-mass dataset. Browser-native ES modules, IndexedDB, Google Identity Services, and Google Drive v3. No LLM API, backend photo storage, or prediction model is included.

## Use
Open the published HTTPS site in Safari. Settings contains the one-time Google OAuth setup. Create a session, enter tare and measured full-reference net water mass, choose a target level, enter the gross balance reading, and follow each view. Review visibility and quality before Save & Next. That button commits original JPEG bytes (or converts other supported formats to JPEG) to IndexedDB, then queues Drive upload when connected.

Drive creates BottleCapture Dataset / bottle / physical instance / unique session / fill level. Each JPEG has a JSON sidecar with its measured grams and metadata. Local ZIP export contains images/, labels.csv and index.json. Export per session on phones. No local records are auto-deleted.

## Google setup
1. Create your own Google Cloud project and enable Google Drive API.
2. Configure Google Auth Platform consent. For an external testing app, add your own account as a test user.
3. Create an OAuth web client. Authorize the exact published site origin as a JavaScript origin.
4. Paste its public client ID into the app's Settings. Never supply a client secret.
5. Connect, approve drive.file access, and test a pilot JPEG and JSON sidecar.

Only `drive.file` scope is requested. The access token stays in tab-scoped sessionStorage across refreshes until expiry or disconnect. Reconnect after expiry or closing the tab. If session storage is unavailable, refresh requires reconnecting. This is separate from ChatGPT's Google Drive connector. Google or managed-account policy may require extra setup.

## Reliability
IndexedDB saves are committed before showing success. Unique slot keys prevent overwrite. Drive IDs are generated and persisted before file creation; retries reuse them. A photo is marked synced only after both JPEG and JSON exist, match their expected byte size and are not in Trash. This checks byte size, not a cryptographic digest. Sync is serialised with Web Locks when available; use one tab. Failed sync stays pending and can be retried. New photos during a sync are drained before it completes. Do not move/delete cloud records during collection.

Safari can pause uploads when backgrounded. Keep the app open until sync completes. Local browser storage can be evicted or cleared. There is no service-worker offline cold start in this version: open online, then temporary disconnection can be tolerated while the page stays loaded. Session measurement is reconfirmed when resuming. Native camera-picker activity is exempt from the pause reset.

Images are only manually reviewed: the app cannot verify mass, focus, identity, angle, or hidden water level. A live video-frame capture may be lower resolution than the iPhone's native still camera. Use the native camera input where possible. Check EXIF orientation in your model loader. Never train on the bundled generated framing illustrations.

## Collection
Four bottle types, 11 target levels, actual grams for each fill, ten views for training and five for validation/holdout. Three training sessions plus one validation and one holdout per bottle = 440 photos/bottle, 1,760 total. Split by independent setup groups; professor-provided validation and test are separate. No model accuracy guarantee.

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
