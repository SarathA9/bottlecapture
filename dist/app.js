import {
  bottles,
  shots,
  esc,
  mass,
  grams,
  countShots,
  photoName,
  photoPath,
  checkRun,
  waterMass,
  csv,
  labelFor,
  uuid,
} from "./core.js";
import {
  all,
  get,
  put,
  setting,
  addPhoto,
  restartRun,
  deleteRun,
  replacePhoto,
  remove,
} from "./db.js";
import { zip } from "./zip.js";
import * as drive from "./drive.js";
let runs = [],
  photos = [],
  page = "home",
  current = null,
  level = 0,
  stream = null,
  candidate = null,
  verified = false,
  captureBusy = false,
  syncMessage = "",
  urls = [],
  timer = null,
  activeShot = 0,
  filePickerOpen = false,
  // Retake mode: { id, run, level, shot } of the saved photo being replaced.
  retake = null,
  // Fill used for a retake when the bottle was refilled and reweighed.
  retakeFill = null,
  refillPending = null;
const $ = (s) => document.querySelector(s),
  $$ = (s) => [...document.querySelectorAll(s)];
const paths = {
  home: "M3 10 12 3l9 7v11h-6v-7H9v7H3z",
  capture: "M4 7h4l2-3h4l2 3h4v14H4z M16 14a4 4 0 1 1-8 0 4 4 0 0 1 8 0",
  dataset: "M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z",
  guide: "M3 4h7l2 2 2-2h7v16h-7l-2 2-2-2H3z M12 6v16",
  settings:
    "M12 3v3 M12 18v3 M3 12h3 M18 12h3 M5.5 5.5l2 2 M16.5 16.5l2 2 M5.5 18.5l2-2 M16.5 7.5l2-2 M17 12a5 5 0 1 1-10 0 5 5 0 0 1 10 0",
  plus: "M12 5v14 M5 12h14",
  arrow: "M5 12h14 M13 6l6 6-6 6",
  cloud:
    "M7 18H5a4 4 0 0 1-1-8 7 7 0 0 1 13-2 5 5 0 0 1 2 10h-2 M12 21V11 M8 15l4-4 4 4",
  check: "m5 12 4 4 10-10",
  download: "M12 3v12 M7 10l5 5 5-5 M4 17v4h16v-4",
  back: "M19 12H5 M11 6l-6 6 6 6",
};
const icon = (n) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${paths[n] || paths.capture}"/></svg>`;
const bottleSvg = (b) =>
  `<svg class="bottle-svg" viewBox="0 0 70 190" aria-hidden="true"><defs><linearGradient id="g${b.id}"><stop stop-color="${b.color}"/><stop offset=".4" stop-color="#d4e0ce" stop-opacity=".8"/><stop offset="1" stop-color="${b.color}"/></linearGradient></defs><path d="M25 12h20v38c0 14 14 15 14 34v88q0 9-9 9H20q-9 0-9-9V84c0-19 14-20 14-34z" fill="url(#g${b.id})" stroke="#b1c3ad" stroke-width="1.2"/><rect x="24" y="5" width="22" height="13" rx="3" fill="${b.cap}"/><path d="M17 91v75q0 8 7 8" fill="none" stroke="#fff" opacity=".3" stroke-width="3"/><rect x="11" y="98" width="48" height="48" rx="2" fill="${b.label}"/><path d="M18 106h34M18 138h34" stroke="#899576" stroke-width=".7"/><text x="35" y="119" text-anchor="middle" font-size="6" font-family="serif" fill="#42603b">${b.id === "B01" ? "KONDRAUER" : b.id === "B04" ? "FACHINGEN" : "LABERTALER"}</text><text x="35" y="130" text-anchor="middle" font-size="4" fill="#788568">${b.id === "B02" ? "MILD" : "MINERALWASSER"}</text></svg>`;
function toast(message) {
  const t = $("#toast");
  t.textContent = message;
  t.style.display = "block";
  clearTimeout(timer);
  timer = setTimeout(() => (t.style.display = "none"), 6500);
}
function fail(e) {
  console.error(e);
  toast(e.message || String(e));
}
let trashCount = 0;
async function refresh() {
  [runs, photos, trashCount] = await Promise.all([
    all("runs"),
    all("photos"),
    drive.pendingTrash(),
  ]);
  runs.sort((a, b) => b.created.localeCompare(a.created));
}
function stopCamera() {
  document.body.classList.remove("camera-open");
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
}
function cleanup() {
  stopCamera();
  urls.forEach(URL.revokeObjectURL);
  urls = [];
  candidate = null;
  verified = false;
  captureBusy = false;
}
function objectURL(b) {
  const u = URL.createObjectURL(b);
  urls.push(u);
  return u;
}
function nav(p) {
  cleanup();
  if (p !== "shoot") {
    retake = null;
    retakeFill = null;
  }
  refillPending = null;
  page = p;
  render();
  window.scrollTo(0, 0);
}
function done(r, l) {
  return photos.filter(
    (p) => p.run === r.id && (l === undefined || p.level === l),
  ).length;
}
// A session started by another Google account in the shared folder. Shown for
// information only: everyone can continue, retake and delete every session.
function foreign(r) {
  return (
    !!r?.uploadedBy &&
    !!settingsCache.email &&
    r.uploadedBy.toLowerCase() !== settingsCache.email.toLowerCase()
  );
}
// This device's folder is its own and nobody else has access: likely not shared yet.
function lonely() {
  return (
    !!settingsCache.rootInfo?.ownedByMe &&
    (settingsCache.people || []).length <= 1
  );
}
function activeFill() {
  return retakeFill || current.fills[level];
}
function nextShot(r, l) {
  return Array.from({ length: countShots(r) }, (_, i) => i).find(
    (i) => !photos.some((p) => p.run === r.id && p.level === l && p.shot === i),
  );
}
function header(title, desc, action = "") {
  return `<div class="heading"><div><div class="eyebrow">Water mass research · Collection studio</div><h1>${title}</h1><p>${desc}</p></div>${action}</div>`;
}
function shell(content) {
  return `<div class="shell"><aside class="sidebar"><div class="brand"><span class="brand-icon">◒</span><div>BottleCapture<small>COLLECTION STUDIO</small></div></div><nav class="nav" aria-label="Main navigation">${[
    ["home", "Overview"],
    ["capture", "Sessions"],
    ["dataset", "Dataset"],
    ["guide", "Field guide"],
    ["settings", "Settings"],
  ]
    .map(
      ([p, t]) =>
        `<button data-nav="${p}" class="${page === p || ((page === "session" || page === "shoot" || page === "new") && p === "capture") ? "active" : ""}">${icon(p)}<span>${t}</span>${p === "dataset" ? `<span class="pill-count">${photos.length}</span>` : ""}</button>`,
    )
    .join(
      "",
    )}</nav><div class="sidebar-foot"><strong>A good dataset starts here.</strong>Keep the labels on. Measure every fill. Make every photo count.<hr class="divider">OTH Amberg-Weiden<br>Computer vision project</div></aside><main class="main"><div class="topbar"><span class="crumb">Workspace &nbsp; / &nbsp; <strong>Water in a bottle</strong></span><div class="brand mobile-brand"><span class="brand-icon">◒</span>BottleCapture</div><div class="topright"><span class="badge ${drive.connected() ? "" : "warn"}"><i class="dot"></i>${drive.connected() ? "Drive connected" : navigator.onLine ? "Local collection" : "Offline"}</span><span class="avatar">SA</span></div></div>${content}<div class="footer-note">BOTTLECAPTURE · MEASURE CAREFULLY. CAPTURE CONSISTENTLY. · VERSION __BUILD__</div></main></div>`;
}
function render() {
  let content;
  if (page === "home") content = home();
  else if (page === "capture") content = sessions();
  else if (page === "new") content = newSession();
  else if (page === "session") content = sessionPage();
  else if (page === "shoot") content = shootPage();
  else if (page === "dataset") content = dataset();
  else if (page === "guide") content = guide();
  else content = settings();
  $("#app").innerHTML = shell(content);
  bind();
}
function home() {
  const synced = photos.filter((p) => p.synced).length;
  return `${header("Your next great dataset.", "A little structure. Better photos. More reliable research.", `<button class="btn" data-new="B04">${icon("plus")} New session</button>`)}<section class="hero"><div class="hero-copy"><div class="eyebrow">Built for your bottle project</div><h2>One bottle.<br>Eleven levels.<br>Every detail in place.</h2><p>Follow the shot guide, record the water mass and build a dataset you can trust.</p><button class="btn light" data-new="B04">Start collecting ${icon("arrow")}</button></div><div class="hero-art">${bottles.map(bottleSvg).join("")}</div></section><div class="stats"><div class="stat"><div class="stat-top">Photos collected ${iconSmall("capture")}</div><strong>${photos.length.toLocaleString()}</strong><small>of 1,760 planned across all bottles</small></div><div class="stat"><div class="stat-top">Bottles covered ${iconSmall("dataset")}</div><strong>${new Set(photos.map((p) => runs.find((r) => r.id === p.run)?.bottle)).size}<span class="muted" style="font-size:16px"> / 4</span></strong><small>Each bottle has its own identity</small></div><div class="stat"><div class="stat-top">Saved to Drive ${iconSmall("cloud")}</div><strong>${synced}</strong><small>${photos.length - synced} photos waiting to sync</small></div><div class="stat"><div class="stat-top">Sessions ${iconSmall("check")}</div><strong>${runs.length}</strong><small>${runs.filter((r) => done(r) === 11 * countShots(r)).length} fully photographed</small></div></div><div class="section-head"><h2>Your four bottles</h2><small>Select a bottle to begin</small></div><div class="bottles">${bottles
    .map((b) => {
      const n = photos.filter(
        (p) => runs.find((r) => r.id === p.run)?.bottle === b.id,
      ).length;
      return `<button class="bottle-card" data-new="${b.id}"><div class="bottle-stage"><span class="bottle-code">${b.id}</span>${bottleSvg(b)}</div><h3>${b.name}</h3><p>${b.detail}</p><div class="progress"><i style="width:${Math.min((n / 440) * 100, 100)}%"></i></div><div class="card-foot"><span>${n} / 440 photos</span><span>Start →</span></div></button>`;
    })
    .join(
      "",
    )}</div><div class="bottom-grid"><section class="panel"><div class="bar"><h3>Recent sessions</h3><button class="text-link" data-nav="capture">View all</button></div>${
    runs.length
      ? runs
          .filter((r) => !r.archived)
          .slice(0, 3)
          .map(runRow)
          .join("")
      : `<div class="empty">${icon("capture")}<h3>A fresh start.</h3><p>Your first collection session will appear here.</p><button class="btn small secondary" data-new="B04">Create a session</button></div>`
  }</section><section class="panel soft"><div class="eyebrow">Before the first shutter</div><h3>Three things to get right.</h3><ol class="steps"><li><strong>Keep the label on.</strong> Hidden water levels belong in your dataset too.</li><li><strong>Use the balance.</strong> Record grams, not a guessed volume.</li><li><strong>Keep the whole bottle.</strong> Cap, label and base, all in focus.</li></ol><button class="text-link" data-nav="guide">Read the collection guide →</button></section></div>`;
}
function iconSmall(n) {
  return `<span style="width:15px;height:15px;display:inline-flex">${icon(n)}</span>`;
}
function runRow(r) {
  const b = bottles.find((b) => b.id === r.bottle);
  return `<div class="row"><div><strong>${esc(r.session)}${r.archived ? " (archived)" : ""} · ${b.name}</strong><small>${esc(r.instance)} · ${esc(r.split)} · ${done(r)} / ${11 * countShots(r)} photos${foreign(r) ? " · by " + esc(r.uploadedBy) : ""}</small></div><div class="actions"><button class="btn small secondary" data-run="${r.id}">${r.archived ? "View archived attempt" : "Open session"}</button>${!r.archived ? `<button class="btn small" data-resume="${r.id}">Continue photos</button>` : ""}</div></div>`;
}
function sessions() {
  return `${header("Collection sessions.", "Resume where you stopped, or start an independent setup.", `<button class="btn" data-new="B04">${icon("plus")} New session</button>`)}<div class="notice">Plan per bottle: 3 training sessions × 110 photos, 1 validation session × 55, and 1 holdout session × 55. Professor-provided datasets stay separate.</div><section class="panel">${runs.length ? runs.map(runRow).join("") : `<div class="empty"><h2>Your workspace is ready.</h2><p>Create a session and the app will guide every shot.</p><button class="btn" data-new="B04">Start your first session</button></div>`}</section>`;
}
let selectedBottle = "B04";
function field(label, name, value = "", help = "", type = "text") {
  return `<label class="field">${label}<input name="${name}" value="${esc(value)}" ${type === "decimal" ? 'inputmode="decimal"' : `type="${type}"`} required>${help ? `<small>${help}</small>` : ""}</label>`;
}
function newSession() {
  return `${header("Set up your session.", "A few careful measurements now keep every photo correctly labelled.")}<form id="sessionForm"><div class="grid2"><section class="panel"><div class="eyebrow">01 · Identify</div><h2>Bottle & environment</h2><hr class="divider"><label class="field">Bottle<select name="bottle">${bottles.map((b) => `<option value="${b.id}" ${selectedBottle === b.id ? "selected" : ""}>${b.id} · ${b.name} · ${b.detail}</option>`).join("")}</select></label><div class="grid2">${field("Physical bottle ID", "instance", "I01", "Use I02 for a replacement bottle.")}${field("Session label", "session", "S" + String(runs.length + 1).padStart(2, "0"), "A new session means a fresh collection setup.")}</div><div class="grid2">${field("Setup / leakage group", "setup", "SET" + String(runs.length + 1).padStart(2, "0"), "Related fills and near-identical setups share this ID.")}<label class="field">Dataset split<select name="split"><option value="train">Training · 10 views / level</option><option value="validation">Internal validation · 5 views / level</option><option value="holdout">Internal holdout · 5 views / level</option></select><small>Do not change a setup between splits.</small></label></div>${field("Background", "background", "", "Example: wooden table, plain cream wall")}${field("Lighting", "lighting", "", "Example: window on left, diffuse daylight")}</section><section class="panel"><div class="eyebrow">02 · Measure</div><h2>Balance readings</h2><hr class="divider">${field("Empty bottle + cap (g)", "tare", "", "Weigh the dry, empty bottle with its original label and cap.", "decimal")}${field("Full-reference water only (g)", "reference", "", "Fill to your normal full reference. Subtract the empty bottle + cap mass. Use the same reference for this bottle in later sessions.", "decimal")}${field("Balance step / resolution (g)", "resolution", "1", "Smallest step your balance displays, e.g. 1 or 0.1.", "decimal")}<div class="notice">Net water mass = filled bottle + cap − empty bottle + cap. Printed millilitres are not your measured mass.</div><label class="check"><input type="checkbox" required>Original label stays on, and I use the same cap for every weighing.</label><label class="check"><input type="checkbox" required>I will photograph every level under this setup, without a scale display, measuring jug or mass label in the image.</label><button class="btn" type="submit">Create session ${icon("arrow")}</button></section></div></form>`;
}
function sessionPage() {
  const r = current,
    b = bottles.find((b) => b.id === r.bottle);
  return `${header(`${b.name} · ${esc(r.session)}`, `${esc(r.split)} · ${esc(r.instance)} · ${esc(r.background)}`, `<button class="btn secondary" data-nav="capture">${icon("back")} Sessions</button>`)}<div class="grid2"><section class="panel"><div class="eyebrow">Session progress</div><h2>${done(r)} <span class="muted">/ ${11 * countShots(r)} photos</span></h2><p>${countShots(r)} views at each of 11 fill levels.</p><div class="progress"><i style="width:${(done(r) / (11 * countShots(r))) * 100}%"></i></div>${foreign(r) ? `<p class="tiny">Started by ${esc(r.uploadedBy)}. You can add, retake and delete photos here too.</p>` : ""}<div class="actions">${!r.archived ? `<button class="btn small" data-resume="${r.id}">Continue photos</button><button class="btn small secondary" id="resetSession">Reset session</button>` : '<span class="badge">Archived attempt</span>'}<button class="btn small secondary" data-export="${r.id}">${icon("download")} Export session ZIP</button><button class="btn small danger" id="deleteSession">Delete session</button></div></section><section class="panel soft"><div class="eyebrow">Your measurement reference</div><h2>${grams(r.reference)} g <span class="muted" style="font-size:13px">water at 100%</span></h2><p>Empty bottle + cap: ${grams(r.tare)} g<br>Scale step: ${grams(r.resolution)} g · Setup: ${esc(r.setup)}</p></section></div><div class="section-head"><h2>Choose a fill level</h2><small>Actual grams are recorded next</small></div><div class="levels">${Array.from({ length: 11 }, (_, l) => `<button class="level ${done(r, l) === countShots(r) ? "complete" : ""}" data-level="${l}" ${r.archived ? "disabled" : ""}><strong>${l * 10}%</strong><small>Target ≈ ${grams((r.reference * l) / 10)} g</small><small>${done(r, l)} / ${countShots(r)} photos ${done(r, l) === countShots(r) ? "✓" : ""}</small></button>`).join("")}</div><div class="notice">Targets help you choose fills. The exact balance reading becomes the training label. Let the water settle and wipe the outside dry. If you refill a level after leaving the setup, start a new session instead of reusing its old measurement.</div>`;
}
function angleDiagram(s) {
  return `<div class="angle-diagram"><svg viewBox="0 0 300 145" aria-label="Camera framing illustration"><path d="M40 130h220" stroke="#c5d1b8"/><path d="M179 25h15v30l12 14v57h-39V69l12-14z" fill="#d3e0c5" stroke="#7c9870" stroke-width="2"/><path d="M169 91h35v21h-35z" fill="#fafbf7"/><g transform="translate(${s === 0 || s === 4 || s === 5 || s === 9 ? "45 70" : "60 20"}) rotate(${s === 0 || s === 4 || s === 5 || s === 9 ? "0" : "25"})"><rect width="34" height="24" rx="5" fill="#315c46"/><circle cx="18" cy="12" r="6" fill="#e6eed8"/><path d="M42 12h65" stroke="#91a782" stroke-dasharray="4 4"/></g><text x="150" y="143" text-anchor="middle" font-size="9" fill="#6e8268">${shots[s][3]} · whole bottle in frame</text></svg></div>`;
}
function shootPage() {
  const r = current,
    shot = retake ? retake.shot : nextShot(r, level);
  activeShot = shot ?? 0;
  const f = verified ? activeFill() : r.fills?.[level];
  if (shot === undefined)
    return `${header("Level complete.", "All views for this fill are saved locally.")}<section class="panel"><h2>${level * 10}% · ${grams(f.mass)} g water</h2><p>Choose the next fill level and weigh it before taking more photos.</p><button class="btn" id="backSession">Choose next level ${icon("arrow")}</button><p class="tiny">${photos.filter((p) => p.run === r.id && p.level === level && !p.synced).length} photos at this level still need a Drive upload or local export.</p></section>`;
  if (!verified)
    return `${header(retake ? `Retake · ${level * 10}% fill · view ${shots[shot][0]}` : `${level * 10}% fill · weigh first.`, retake ? `Saved photo mass: ${grams(f.mass)} g water (${grams(f.gross)} g on the balance). Skip weighing if the water has not changed.` : `Approximate target: ${grams((r.reference * level) / 10)} g of water. Keep the label on.`)}<div class="grid2"><section class="panel"><h2>${retake ? "Has the water changed since this photo?" : f ? "Confirm the same fill" : "Record the actual mass"}</h2>${retake ? `<div class="notice">If you have not added or poured out water since the original photo, keep the saved mass and go straight to the camera.</div><label class="check"><input type="checkbox" id="sameWaterOk">I have not added or removed water since the original photo.</label><button class="btn" type="button" id="sameWater" disabled>Keep ${grams(f.mass)} g and retake ${icon("arrow")}</button><hr class="divider"><h3>Water changed? Weigh again</h3>` : ""}<p>${retake ? "Refill to the saved reading and weigh with the same cap. If it matches within one scale step, the retake keeps the original label. If not, you can confirm the new reading, and only this photo gets the new measured mass." : f ? "Reweigh without adding or removing water. The reading must match this fill within one scale step. If it changed, use a new session." : "Weigh the bottle with water and its cap. Enter exactly what the balance shows."}</p><form id="massForm">${field("Filled bottle + cap (g)", "gross", "", "Empty bottle + cap: " + grams(r.tare) + " g", "decimal")}<div id="massPreview" class="notice">Your net water mass will appear here.</div><label class="check"><input type="checkbox" required>The water is still, the outside is dry, and the balance reading is stable.</label><button class="btn" type="submit" id="massSubmit">Confirm & start photos ${icon("arrow")}</button></form><button class="text-link" id="backSession">${retake ? "← Cancel retake" : "← Back to fill levels"}</button></section><section class="panel soft"><h3>Keep it consistent</h3><ol class="steps"><li>Weigh with the <strong>same cap</strong> each time.</li><li>Place the bottle on your photography surface.</li><li>Keep the scale and mass notes <strong>outside the frame</strong>.</li><li>Do not alter the fill between the ${countShots(r)} views.</li></ol><div class="notice warn">If the water line is hidden by the label, keep the photo. You will mark its visibility during review.</div></section></div>`;
  const s = shots[shot];
  return `${header(`${retake ? "Retake · " : ""}Shot ${shot + 1} of ${countShots(r)} · ${s[0]}`, `${level * 10}% target · Actual water: ${grams(f.mass)} g`, `<button class="btn secondary small" id="backSession">${retake ? "Cancel retake" : "Pause session"}</button>`)}${retake ? '<div class="notice warn">Retake mode. When you save, this photo replaces the old one here and on Google Drive. The old Drive files move to Drive Trash.</div>' : ""}<div class="capture-layout"><section><div id="cameraStage"><div class="viewfinder" id="viewfinder"><div class="cam-placeholder">${icon("capture")}<p style="color:#b7c8b7">Your next research image.</p><button class="btn light" id="startCamera">Open live camera</button><p class="tiny" style="color:#a8baaa">Or use iPhone Camera below for a full-resolution photo.</p></div></div><div id="cameraControls"></div></div><label class="btn secondary" style="width:100%;margin:12px 0;cursor:pointer">${icon("capture")} Use iPhone Camera / choose photo<input id="fileCamera" type="file" accept="image/*" capture="environment" hidden></label><p class="tiny">The live camera may use a lower resolution. Use iPhone Camera for the device’s still-photo capture. Review image dimensions before saving.</p><div id="review"></div></section><section class="panel instruction-panel"><div class="eyebrow">${esc(s[3])}</div><h2 class="instruction">${s[1]}</h2><p>${s[2]}</p>${angleDiagram(shot)}<ol class="steps"><li>Original label on. Bottle upright.</li><li>Cap and base visible, with a small margin.</li><li>Tap to focus in the iPhone camera. Avoid glare and motion blur.</li><li>No scale, mass notes or measuring jug in view.</li></ol><div class="eyebrow">Assigned filename</div><div class="filename">${photoName(r, level, shot)}</div><p class="tiny">${photoPath(r, level, shot).split("/").slice(0, -1).join(" / ")}</p></section></div>`;
}
function dataset() {
  return `${header("Your dataset, organised.", "Every approved photo keeps its measured mass and capture details.", `<div class="actions"><button class="btn secondary" id="pullDrive">${icon("download")} Load from Drive</button><button class="btn" id="syncNow">${icon("cloud")} Sync now</button></div>`)}<div class="notice">${photos.length} local photos · ${photos.filter((p) => p.synced).length} confirmed on Drive · ${photos.filter((p) => !p.synced).length} waiting.${trashCount ? ` ${trashCount} old Drive files waiting to move to Trash.` : ""} ${lonely() ? `<strong>Not shared yet:</strong> only you can see this dataset folder. Open Settings to invite your partner, or ask the dataset owner to invite ${esc(settingsCache.email)}. ` : ""}${settingsCache.rootInfo ? `Shared Drive folder owned by <strong>${esc(settingsCache.rootInfo.owners?.[0]?.emailAddress || "unknown")}</strong>. Changes from everyone sharing it load automatically.` : "Connect Google Drive in Settings to work on the shared dataset."}</div><div class="toolbar"><select id="datasetFilter" aria-label="Filter by bottle"><option value="all">All bottles</option>${bottles.map((b) => `<option value="${b.id}">${b.id} · ${b.name}</option>`).join("")}</select><button class="btn secondary small" id="csvExport">${icon("download")} Download labels CSV</button><button class="btn secondary small" data-export="all">Export all ZIP</button></div><p class="sync-status" id="syncStatus">${esc(syncMessage)}</p><div class="photo-grid" id="photoGrid">${photoTiles(photos)}</div>${!photos.length ? '<section class="panel empty"><h2>No photos yet.</h2><p>Your reviewed photos will appear here with their actual water mass.</p><button class="btn" data-new="B04">Start collecting</button></section>' : ""}`;
}
function photoTiles(list) {
  return [...list]
    .reverse()
    .map(
      (p) =>
        `<article class="photo-tile"><img src="${objectURL(p.blob)}" alt="${esc(p.name)}" loading="lazy"><div class="info"><div class="bar"><strong>${grams(p.mass)} g</strong><span class="badge ${p.synced ? "" : "warn"}">${p.synced ? "On Drive" : "Local"}</span></div><p>${esc(p.name)}</p><p>${esc(p.visibility)} surface · ${p.width} × ${p.height}${p.retakenAt ? " · retaken" : ""}</p><button class="text-link" data-photo="${p.id}">View, retake or download</button></div></article>`,
    )
    .join("");
}
function guide() {
  return `${header("The field guide.", "Simple habits that make your dataset useful.")}<div class="grid2"><section class="panel"><div class="eyebrow">The protocol</div><h2>One measured fill. Multiple views.</h2><ol class="steps"><li><strong>Weigh the empty bottle and cap.</strong> This is your tare.</li><li><strong>Establish a full reference.</strong> Measure the water mass at normal full fill. Keep this reference for that physical bottle.</li><li><strong>Use 11 targets.</strong> Empty, 10%, 20% … 100%. Record actual grams, even if the target is not exact.</li><li><strong>Capture every view at every level.</strong> Training uses 10; internal validation and holdout use 5.</li><li><strong>Vary setups between sessions.</strong> Different backgrounds, soft daylight / room lighting, modest distances and camera positions.</li><li><strong>Keep related photos together.</strong> Never randomly split near-duplicate photos across training and evaluation.</li></ol></section><section class="panel soft"><div class="eyebrow">When the surface is hidden</div><h2>Keep the label. Keep the example.</h2><p>Choose “Hidden” in the review screen. Do not remove the label or invent a visible water line.</p><p>A model may learn other image cues, but an opaque label can make different masses look the same. More photos cannot guarantee an exact answer where the image contains no distinguishing evidence.</p><p>Evaluate hidden and visible cases separately. Compare the model against a simple average-mass baseline.</p><div class="notice">The app records measurements and guides photography. It does not measure water from a photo or automatically verify focus, angle or bottle identity.</div></section></div><div class="section-head"><h2>Framing examples</h2><small>Illustrations, not training images</small></div><div class="grid2"><section class="panel"><h3>Kondrauer & Labertaler Mild</h3><img class="guide-img" src="guide-glass.png" alt="Generated framing examples for Kondrauer and Labertaler Mild bottles"></section><section class="panel"><h3>Labertaler Medium & Fachingen</h3><img class="guide-img" src="guide-mixed.png" alt="Generated framing examples for Labertaler Medium and Fachingen bottles"></section></div><p class="tiny">AI-generated examples show composition only. Bottle details and liquid appearance may be imperfect. Never add these illustrations to your dataset.</p><section class="panel"><h3>Your two-week collection plan</h3><div class="grid2"><div><p><strong>Days 1–2:</strong> Measure references. Take a small pilot. Check sharpness, filenames, actual grams and exports on your laptop.</p><p><strong>Days 3–8:</strong> Three training sessions per bottle, with different backgrounds and lighting. Include all 11 levels in each session.</p></div><div><p><strong>Days 9–12:</strong> Collect independent internal validation and holdout sessions. Keep professor-provided data separate.</p><p><strong>Days 13–14:</strong> Audit labels and missing views, export backups, and inspect model errors. Never tune on the final test set.</p></div></div></section>`;
}
let settingsCache = {};
function settings() {
  return `${header("Make the studio yours.", "Connect storage, protect your dataset and keep collecting.")}<div class="grid2"><section class="panel"><div class="bar"><h2>Google Drive</h2><span class="badge ${drive.connected() ? "" : "warn"}">${drive.connected() ? "Connected" : "Setup / reconnect"}</span></div><p>Save & Next uploads the approved photo and its measured-mass JSON record into the “BottleCapture Dataset” folder, yours or one shared with you.</p><form id="driveForm">${field("Google OAuth web client ID", "client", settingsCache.client || "", "A public client ID ending in .apps.googleusercontent.com. Never enter a client secret.")}<button class="btn secondary" type="submit">Save client ID</button></form><div class="actions"><button class="btn" id="connectDrive">${icon("cloud")} Connect Google Drive</button><button class="btn secondary" id="syncNow">Sync pending</button><button class="btn secondary" id="pullDrive">Load from Drive</button>${drive.connected() ? '<button class="btn ghost" id="disconnectDrive">Disconnect</button>' : ""}</div><p class="tiny">${settingsCache.email ? "Dataset account: " + esc(settingsCache.email) : "Connect once, then reconnect when Google’s access token expires."}</p>${settingsCache.root ? `<a class="text-link" href="https://drive.google.com/drive/folders/${encodeURIComponent(settingsCache.root)}" target="_blank" rel="noopener">Open your Drive dataset ↗</a>` : ""}<p id="syncStatus" class="sync-status">${esc(syncMessage)}</p><hr class="divider"><h3>Shared dataset folder</h3><p class="tiny">${settingsCache.rootInfo ? `Uploading into “${esc(settingsCache.rootInfo.name)}”, owned by ${esc(settingsCache.rootInfo.owners?.[0]?.emailAddress || "unknown")}.${settingsCache.rootInfo.capabilities?.canAddChildren === false ? " You only have view access: ask the owner to make you an Editor." : ""}` : "Connect Drive to see which dataset folder this device uses."} A folder someone shared with you is found automatically. To pick a different one, paste its Drive link.</p>${lonely() ? `<div class="notice warn">Only you can see this folder. If your partner started the dataset, ask them to invite <strong>${esc(settingsCache.email)}</strong> in their Settings. If you started it, invite your partner below.</div>` : ""}<h3>People on this dataset</h3><ul class="steps">${(settingsCache.people || []).map((x) => `<li>${esc(x.emailAddress || x.displayName)} · ${x.role === "owner" ? "owner" : x.role === "writer" ? "can edit" : esc(x.role)}</li>`).join("") || "<li>Connect Drive to see who has access.</li>"}</ul>${settingsCache.rootInfo?.capabilities?.canShare !== false && settingsCache.rootInfo ? `<form id="inviteForm">${field("Invite a partner (Google email)", "email", "", "They get edit access and an email from Google. Use the exact address they connect with.", "email")}<button class="btn small" type="submit">Invite as editor</button></form>` : ""}<form id="rootForm">${field("Dataset folder link (optional)", "root", "", "Example: https://drive.google.com/drive/folders/…")}<div class="actions"><button class="btn secondary small" type="submit">Use this folder</button>${settingsCache.datasetRoot ? '<button class="btn ghost small" type="button" id="clearRoot">Use automatic folder</button>' : ""}</div></form><details><summary class="text-link">Add a friend who captures on his own phone</summary><ol class="steps"><li>In Google Cloud Console → Google Auth Platform → Audience, add your friend’s Google email as a <strong>test user</strong>.</li><li>In Google Drive, share the “BottleCapture Dataset” folder with your friend as <strong>Editor</strong>.</li><li>Your friend opens this site, pastes the same client ID in Settings, and connects with his own Google account.</li><li>The app finds the shared folder. You both work on one central dataset: new photos, retakes and deletes from either phone show up on every device within a couple of minutes.</li><li>His uploads use his own Google storage. Give his physical bottle its own instance ID (for example I02).</li></ol></details><details><summary class="text-link">One-time Google setup instructions</summary><ol class="steps"><li>Open <a href="https://console.cloud.google.com/" target="_blank" rel="noopener">Google Cloud Console</a> on your laptop. Create a project called BottleCapture.</li><li>Enable the <strong>Google Drive API</strong>.</li><li>Configure Google Auth Platform: your app name, contact email, and audience. For a personal external testing app, add your own Google email as a test user.</li><li>Create an OAuth client with application type <strong>Web application</strong>.</li><li>Add this exact <strong>Authorized JavaScript origin</strong>:<div class="filename">${esc(location.origin)}</div></li><li>Copy the client ID here, save it, and tap Connect Google Drive. No client secret or redirect URI is needed for this browser token flow.</li><li>Allow access to Google Drive. Full Drive access is needed so two Google accounts can work in one shared folder. The app only reads and writes inside the BottleCapture Dataset folder. Take one pilot photo and confirm both its JPEG and JSON arrive before a full session.</li></ol><p class="tiny">Google may require additional consent-screen configuration. Your password stays with Google; access tokens stay in tab session storage until expiry or disconnect, separate from the dataset.</p></details></section><section class="panel"><h2>Local safety net</h2><p>Approved photos are saved in this browser before uploading. Keep this tab open until uploads finish. Safari may pause work when the phone locks.</p><div class="notice warn">Browser storage is not a permanent backup. Clearing website data can remove unexported photos. Private browsing is unsuitable for collection.</div><div class="actions"><button class="btn secondary" data-export="all">${icon("download")} Export all photos + labels</button><button class="btn secondary" id="csvExport">Labels CSV</button><button class="btn ghost" id="persistStorage">Request persistent storage</button></div><p id="storageStatus" class="tiny"></p><hr class="divider"><h3>Use it on your iPhone</h3><ol class="steps"><li>Open this site in <strong>Safari</strong> and sign in to access your private app.</li><li>Use Share → <strong>Add to Home Screen</strong> for quick access.</li><li>Allow camera access when prompted. Start with a pilot session.</li></ol><p class="tiny">This version requires the site to load online. If the connection drops while it is open, photos can stay locally queued. Reopen online and reconnect Drive to resume.</p><hr class="divider"><h3>What stays on your device?</h3><p class="tiny">Photos, measurements and setup notes are stored locally. Connecting Drive uploads approved photos and per-photo labels to your own account. This app uses no LLM API and does not train or run your prediction model.</p></section></div>`;
}
function on(sel, event, fn) {
  $(sel)?.addEventListener(event, (e) => {
    try {
      Promise.resolve(fn(e)).catch(fail);
    } catch (error) {
      fail(error);
    }
  });
}
function resumeSession(id) {
  current = runs.find((r) => r.id === id);
  if (!current || current.archived) return;
  retake = null;
  retakeFill = null;
  const next = Array.from({ length: 11 }, (_, n) => n).find(
    (n) => nextShot(current, n) !== undefined,
  );
  if (next === undefined) {
    nav("session");
    toast("All photos in this session are complete.");
    return;
  }
  level = next;
  nav("shoot");
}
function confirmReset() {
  const old = current,
    d = $("#modal");
  d.innerHTML = `<h2>Reset ${esc(old.session)}?</h2><p>This starts a fresh attempt with zero photos and new fill measurements. Bottle, setup and reference measurements are kept.</p><p>The previous attempt and its photos remain archived and available for export. Existing Google Drive files stay in their original folder; new photos use a separate folder.</p><div class="actions"><button class="btn" id="confirmReset">Archive attempt and restart</button><button class="btn secondary" id="cancelReset">Cancel</button></div>`;
  d.showModal();
  $("#cancelReset").onclick = () => d.close();
  $("#confirmReset").onclick = async () => {
    const button = $("#confirmReset");
    button.disabled = true;
    try {
      current = await restartRun(old.id, uuid());
      d.close();
      await refresh();
      nav("session");
      toast("Session reset. Previous photos are in the archived attempt.");
    } catch (e) {
      button.disabled = false;
      fail(e);
    }
  };
}
function confirmDelete() {
  const r = current,
    d = $("#modal"),
    list = photos.filter((p) => p.run === r.id),
    onDrive = list.filter((p) => p.cloud).length;
  d.innerHTML = `<h2>Delete ${esc(r.session)}?</h2><p>This removes the session, its fill measurements and all ${list.length} photos from this device.</p><p>${onDrive ? `${onDrive} photos were sent to Google Drive. It is removed from Google Drive for everyone sharing this dataset. The owner’s files go to Drive Trash, where they can be restored for 30 days.` : "No photos from this session are on Google Drive."}${onDrive && !drive.connected() ? " Drive is not connected now, so the cloud folder is removed at your next sync." : ""}</p><div class="notice warn">Export the session ZIP first if you may need these photos.</div><label class="check"><input type="checkbox" id="deleteOk">I understand that this session and its photos will be deleted.</label><div class="actions"><button class="btn danger" id="confirmDelete" disabled>Delete session</button><button class="btn secondary" id="cancelDelete">Cancel</button></div>`;
  d.showModal();
  $("#deleteOk").onchange = (e) =>
    ($("#confirmDelete").disabled = !e.target.checked);
  $("#cancelDelete").onclick = () => d.close();
  $("#confirmDelete").onclick = async () => {
    const button = $("#confirmDelete");
    button.disabled = true;
    button.textContent = "Deleting…";
    try {
      // Wait for any running upload, so it cannot recreate files for this session.
      const cloudNow = await drive.exclusive(async () => {
        await deleteRun(r.id);
        if (drive.connected() && navigator.onLine) {
          await drive.emptyTrash();
          return true;
        }
        return false;
      });
      d.close();
      current = null;
      await refresh();
      nav("capture");
      toast(
        onDrive && !cloudNow
          ? "Session deleted on this device. Connect Drive and sync to move its cloud folder to Trash."
          : onDrive
            ? "Session deleted here and moved to Google Drive Trash."
            : "Session deleted.",
      );
    } catch (e) {
      d.close();
      await refresh();
      if (!runs.some((x) => x.id === r.id)) {
        current = null;
        nav("capture");
        toast(
          "Session deleted on this device. Drive cleanup will retry at your next sync: " +
            e.message,
        );
      } else fail(e);
    }
  };
}
function startRetake(p) {
  const r = runs.find((r) => r.id === p.run);
  if (!r || r.archived)
    throw Error("Photos in archived attempts cannot be retaken.");
  $("#modal").close();
  current = r;
  level = p.level;
  retake = { id: p.id, run: p.run, level: p.level, shot: p.shot };
  retakeFill = null;
  nav("shoot");
}
function bind() {
  on("#deleteSession", "click", confirmDelete);
  for (const b of $$("[data-resume]"))
    b.onclick = () => resumeSession(b.dataset.resume);
  on("#resetSession", "click", confirmReset);
  for (const b of $$("[data-nav]")) b.onclick = () => nav(b.dataset.nav);
  for (const b of $$("[data-new]"))
    b.onclick = () => {
      selectedBottle = b.dataset.new;
      nav("new");
    };
  for (const b of $$("[data-run]"))
    b.onclick = () => {
      current = runs.find((r) => r.id === b.dataset.run);
      nav("session");
    };
  for (const b of $$("[data-level]"))
    b.onclick = () => {
      retake = null;
      retakeFill = null;
      level = Number(b.dataset.level);
      nav("shoot");
    };
  for (const b of $$("[data-export]"))
    b.onclick = () => exportZip(b.dataset.export).catch(fail);
  bindPhotos();
  on("#backSession", "click", () => nav(retake ? "dataset" : "session"));
  on("#sessionForm", "submit", async (e) => {
    e.preventDefault();
    const f = new FormData(e.target),
      r = {
        id: uuid(),
        bottle: f.get("bottle"),
        instance: f.get("instance").trim(),
        session: f.get("session").trim(),
        setup: f.get("setup").trim(),
        split: f.get("split"),
        background: f.get("background").trim(),
        lighting: f.get("lighting").trim(),
        tare: mass(f.get("tare")),
        reference: mass(f.get("reference")),
        resolution: mass(f.get("resolution")),
        created: new Date().toISOString(),
        fills: {},
      };
    await refresh();
    checkRun(r, runs);
    await put("runs", r);
    await refresh();
    current = r;
    nav("session");
    toast("Session created. Choose your first fill level.");
  });
  on("#massForm input[name=gross]", "input", (e) => {
    try {
      refillPending = null;
      $("#massPreview").className = "notice";
      $("#massSubmit").innerHTML = `Confirm & start photos ${icon("arrow")}`;
      const n = waterMass(current, level, mass(e.target.value));
      $("#massPreview").textContent =
        `Net water mass: ${grams(n)} g. This is the training label.`;
    } catch {
      $("#massPreview").textContent = "Enter a valid filled bottle + cap mass.";
    }
  });
  on("#massForm", "submit", async (e) => {
    e.preventDefault();
    current = await get("runs", current.id);
    const gross = mass(new FormData(e.target).get("gross")),
      n = waterMass(current, level, gross),
      f = current.fills[level];
    retakeFill = null;
    if (f && Math.abs(gross - f.gross) > current.resolution) {
      if (!retake)
        throw Error(
          "This reading does not match the saved fill. Start a new session if the amount of water changed.",
        );
      if (refillPending !== gross) {
        refillPending = gross;
        $("#massPreview").className = "notice warn";
        $("#massPreview").textContent =
          `This reading gives ${grams(n)} g water, but the saved fill is ${grams(f.mass)} g. Adjust the water and weigh again, or tap the button again to label only this retake with ${grams(n)} g.`;
        $("#massSubmit").textContent = `Use ${grams(n)} g for this retake`;
        return;
      }
      retakeFill = {
        gross,
        mass: n,
        measuredAt: new Date().toISOString(),
        refill: true,
      };
    }
    refillPending = null;
    if (!f) {
      current.fills[level] = {
        gross,
        mass: n,
        measuredAt: new Date().toISOString(),
      };
      await put("runs", current);
    }
    verified = true;
    render();
  });
  on(
    "#sameWaterOk",
    "change",
    (e) => ($("#sameWater").disabled = !e.target.checked),
  );
  on("#sameWater", "click", () => {
    if (!retake || !$("#sameWaterOk").checked) return;
    retakeFill = null;
    verified = true;
    render();
  });
  on("#startCamera", "click", startCamera);
  on("#fileCamera", "click", () => {
    filePickerOpen = true;
  });
  on("#fileCamera", "cancel", () => {
    filePickerOpen = false;
  });
  on("#fileCamera", "change", async (e) => {
    filePickerOpen = false;
    const file = e.target.files[0];
    if (file) await prepareCandidate(file);
    e.target.value = "";
  });
  on("#datasetFilter", "change", (e) => {
    const v = e.target.value;
    $("#photoGrid").innerHTML = photoTiles(
      photos.filter(
        (p) => v === "all" || runs.find((r) => r.id === p.run)?.bottle === v,
      ),
    );
    bindPhotos();
  });
  on("#csvExport", "click", () =>
    download(
      new Blob(
        [
          csv(
            photos.map((p) =>
              labelFor(
                p,
                runs.find((r) => r.id === p.run),
              ),
            ),
          ),
        ],
        { type: "text/csv;charset=utf-8" },
      ),
      "labels.csv",
    ),
  );
  on("#driveForm", "submit", async (e) => {
    e.preventDefault();
    const id = new FormData(e.target).get("client").trim();
    if (!/^[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/.test(id))
      throw Error("Paste a valid Google web client ID, not a secret.");
    await setting("client", id);
    settingsCache.client = id;
    toast("Client ID saved. Tap Connect Google Drive.");
  });
  // Start OAuth directly inside the click event to preserve Safari user activation.
  $("#connectDrive")?.addEventListener("click", () => {
    drive
      .connect(settingsCache.client)
      .then(async (u) => {
        await loadSettings();
        render();
        toast(
          "Connected as " + u.emailAddress + ". Loading your Drive dataset…",
        );
        await pullNow();
        if (photos.some((p) => !p.synced)) await syncNow();
      })
      .catch(fail);
  });
  on("#disconnectDrive", "click", () => {
    drive.disconnect();
    render();
    toast("Disconnected. Local photos are unchanged.");
  });
  on("#syncNow", "click", syncNow);
  on("#rootForm", "submit", async (e) => {
    e.preventDefault();
    const v = new FormData(e.target).get("root").trim(),
      id = (v.match(/folders\/([A-Za-z0-9_-]{10,})/) ||
        v.match(/^([A-Za-z0-9_-]{10,})$/) ||
        [])[1];
    if (!id) throw Error("Paste a Google Drive folder link.");
    await useRoot(id);
  });
  on("#clearRoot", "click", () => useRoot(null));
  on("#inviteForm", "submit", async (e) => {
    e.preventDefault();
    const email = new FormData(e.target).get("email").trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
      throw Error("Enter a valid email address.");
    if (email === (settingsCache.email || "").toLowerCase())
      throw Error("That is your own account.");
    await drive.invite(email);
    await loadSettings();
    render();
    toast(
      `${email} can now edit the dataset. Ask them to reopen the app and connect Drive.`,
    );
  });
  on("#pullDrive", "click", () => pullNow());
  on("#persistStorage", "click", async () => {
    const ok = await navigator.storage?.persist?.();
    $("#storageStatus").textContent = ok
      ? "Persistent storage granted. Keep exporting backups."
      : "Safari did not grant persistent storage. Keep exporting backups.";
  });
}
function bindPhotos() {
  for (const b of $$("[data-photo]"))
    b.onclick = () => {
      const p = photos.find((p) => p.id === b.dataset.photo),
        r = runs.find((r) => r.id === p.run),
        d = $("#modal");
      d.innerHTML = `<h2>${grams(p.mass)} g water</h2><img src="${objectURL(p.blob)}" style="width:100%;max-height:50vh;object-fit:contain" alt="${esc(p.name)}"><p class="filename">${esc(p.path)}</p><p>${esc(r.background)} · ${esc(r.lighting)}<br>Surface: ${esc(p.visibility)} · ${p.width} × ${p.height}</p><div class="actions">${r.archived ? "" : '<button class="btn" id="retakePhoto">Retake this photo</button>'}<button class="btn secondary" id="downloadPhoto">Download JPEG</button><button class="btn ghost" id="closeModal">Close</button></div>${r.archived ? '<p class="tiny">Archived attempts are read-only.</p>' : '<p class="tiny">Retake replaces this photo locally and on Google Drive after you save the new one. Until then, nothing is deleted.</p>'}`;
      d.showModal();
      $("#closeModal").onclick = () => d.close();
      if ($("#retakePhoto"))
        $("#retakePhoto").onclick = () => {
          try {
            startRetake(p);
          } catch (e) {
            fail(e);
          }
        };
      $("#downloadPhoto").onclick = () => download(p.blob, p.name);
    };
}
// Size the live box to the video's real aspect ratio, so the guide frame sits on the image.
// The part of the video frame that becomes the photo. If the phone is upright but the
// camera stream is sideways, use a centred 3:4 portrait crop, so every photo is portrait.
function liveCrop(v) {
  const vw = v.videoWidth,
    vh = v.videoHeight;
  if (window.innerHeight >= window.innerWidth && vw > vh) {
    const w = Math.round((vh * 3) / 4);
    return { sx: Math.round((vw - w) / 2), sy: 0, w, h: vh, cropped: true };
  }
  return { sx: 0, sy: 0, w: vw, h: vh, cropped: false };
}
function fitLive() {
  const v = $("#video"),
    wrap = $("#liveWrap"),
    box = $("#viewfinder");
  if (!v || !wrap || !box || !v.videoWidth) return;
  const c = liveCrop(v),
    scale = Math.min(box.clientWidth / c.w, box.clientHeight / c.h);
  wrap.style.width = Math.floor(c.w * scale) + "px";
  wrap.style.height = Math.floor(c.h * scale) + "px";
  // "cover" shows exactly the centred crop that will be saved.
  v.style.objectFit = c.cropped ? "cover" : "contain";
  const label = $("#camLabel");
  if (label) label.textContent = `LIVE · ${c.w} × ${c.h}`;
}
window.addEventListener("resize", () => requestAnimationFrame(fitLive));
async function openStream(video) {
  const s = await navigator.mediaDevices.getUserMedia({ audio: false, video });
  const v = $("#video");
  v.srcObject = s;
  await v.play();
  if (!v.videoWidth)
    await new Promise((r) =>
      v.addEventListener("loadedmetadata", r, { once: true }),
    );
  return s;
}
async function startCamera() {
  stopCamera();
  if (!navigator.mediaDevices?.getUserMedia)
    throw Error(
      "Live camera needs Safari over HTTPS. Use “iPhone Camera / choose photo” below.",
    );
  $("#viewfinder").innerHTML =
    '<div class="live-wrap" id="liveWrap"><video id="video" autoplay muted playsinline></video><div class="frame"></div></div><span class="cam-label" id="camLabel">STARTING CAMERA…</span>';
  document.body.classList.add("camera-open");
  const portrait = () => window.innerHeight >= window.innerWidth,
    env = { facingMode: { ideal: "environment" } },
    // Ask for the full 4:3 sensor. If the phone is upright but the stream comes back
    // sideways, ask again with portrait dimensions, then fall back to the default stream.
    attempts = [
      { ...env, width: { ideal: 4032 }, height: { ideal: 3024 } },
      {
        ...env,
        width: { ideal: 3024 },
        height: { ideal: 4032 },
        aspectRatio: { ideal: 3 / 4 },
      },
      env,
    ];
  try {
    let lastError;
    for (const video of attempts) {
      try {
        stream?.getTracks().forEach((t) => t.stop());
        stream = await openStream(video);
        const v = $("#video");
        if (portrait() === v.videoHeight >= v.videoWidth) break;
      } catch (e) {
        lastError = e;
        stream?.getTracks().forEach((t) => t.stop());
        stream = null;
      }
    }
    if (!stream) throw lastError || Error("No camera stream.");
    if (page !== "shoot" || !verified) {
      stopCamera();
      return;
    }
    const v = $("#video");
    v.addEventListener("resize", fitLive);
    fitLive();
    $("#cameraControls").innerHTML =
      `<button class="capture-button" id="shutter" aria-label="Take photo">${icon("capture")}</button><button class="btn secondary" id="closeCamera">Close camera</button>`;
    $("#closeCamera").onclick = () => {
      stopCamera();
      render();
    };
    $("#shutter").onclick = () => captureLive().catch(fail);
  } catch (e) {
    console.error(e);
    stopCamera();
    if (page === "shoot") render();
    throw Error(
      "Camera unavailable or permission denied. Use “iPhone Camera / choose photo” below, or allow camera access in Safari settings.",
    );
  }
}
async function captureLive() {
  if (captureBusy) return;
  captureBusy = true;
  const v = $("#video");
  try {
    if (!stream || !v.videoWidth) return;
    const k = liveCrop(v),
      c = document.createElement("canvas");
    c.width = k.w;
    c.height = k.h;
    c.getContext("2d").drawImage(v, k.sx, k.sy, k.w, k.h, 0, 0, k.w, k.h);
    const blob = await new Promise((resolve) =>
      c.toBlob(resolve, "image/jpeg", 0.96),
    );
    if (!blob) throw Error("Camera image could not be created. Try again.");
    await prepareCandidate(blob);
  } finally {
    captureBusy = false;
  }
}
async function prepareCandidate(file) {
  if (file.size > 60 * 1024 * 1024)
    throw Error("Choose a photo smaller than 60 MB.");
  stopCamera();
  const img = new Image(),
    u = objectURL(file);
  img.src = u;
  try {
    await img.decode();
  } catch {
    throw Error(
      "This image format could not be decoded. In iPhone Camera settings choose Most Compatible, or select a JPEG.",
    );
  }
  let blob = file;
  if (file.type !== "image/jpeg") {
    const c = document.createElement("canvas");
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    c.getContext("2d").drawImage(img, 0, 0);
    blob = await new Promise((r) => c.toBlob(r, "image/jpeg", 0.97));
    if (!blob) throw Error("Could not convert the photo to JPEG.");
  }
  candidate = {
    blob,
    width: img.naturalWidth,
    height: img.naturalHeight,
    takenAt: new Date().toISOString(),
    shot: activeShot,
    level,
    run: current.id,
  };
  $("#viewfinder").innerHTML =
    `<img src="${objectURL(blob)}" alt="Review your captured bottle photo"><span class="cam-label">REVIEW · ${candidate.width} × ${candidate.height}</span>`;
  $("#cameraControls").innerHTML = "";
  $("#review").innerHTML =
    `<section class="panel"><div class="eyebrow">Review before saving</div><h3>${grams(activeFill().mass)} g · View ${shots[activeShot][0]}</h3>${Math.min(candidate.width, candidate.height) < 1000 ? '<div class="notice warn">Low image resolution. Consider retaking with iPhone Camera.</div>' : ""}<form id="reviewForm"><label class="field" style="margin-top:16px">Water surface visibility<select name="visibility" required><option value="">Choose after inspecting the photo</option><option value="visible">Visible</option><option value="partial">Partly visible</option><option value="hidden">Hidden behind label / bottle</option><option value="uncertain">Uncertain</option></select></label><label class="check"><input type="checkbox" required>The whole bottle is visible and sharp enough to inspect.</label><label class="check"><input type="checkbox" required>The original label stays on. No mass hints or scale display appear.</label><label class="check"><input type="checkbox" required>This is the current bottle and measured fill, using the requested view.</label><div class="actions"><button class="btn" type="submit" id="savePhoto">${retake ? "Save retake" : "Save & Next"} ${icon("arrow")}</button><button class="btn secondary" type="button" id="retake">Retake</button></div></form><p class="tiny">Saved locally first. ${drive.connected() ? (retake ? "Then the old Drive copy moves to Trash and the new photo uploads." : "Then automatically queued to Google Drive.") : "Connect Drive later or export this session to keep a backup."}</p></section>`;
  on("#reviewForm", "submit", savePhoto);
  $("#retake").onclick = () => {
    candidate = null;
    render();
  };
}
async function savePhoto(e) {
  e.preventDefault();
  if (!candidate) throw Error("Take a photo first.");
  const button = $("#savePhoto");
  button.disabled = true;
  try {
    const c = candidate;
    if (c.run !== current.id || c.level !== level || !verified)
      throw Error("Reconfirm the fill before saving.");
    if (retake && (retake.run !== c.run || retake.shot !== c.shot))
      throw Error("Retake details changed. Open the photo again from Dataset.");
    const visibility = new FormData(e.target).get("visibility");
    if (!["visible", "partial", "hidden", "uncertain"].includes(visibility))
      throw Error("Choose the surface visibility.");
    const f = activeFill(),
      p = {
        id: `${current.id}:${level}:${c.shot}`,
        run: current.id,
        level,
        shot: c.shot,
        name: photoName(current, level, c.shot),
        path: photoPath(current, level, c.shot),
        mass: f.mass,
        gross: f.gross,
        visibility,
        blob: c.blob,
        width: c.width,
        height: c.height,
        takenAt: c.takenAt,
        synced: false,
      };
    if (retake) {
      p.retakenAt = new Date().toISOString();
      if (f.refill) p.refillMeasuredAt = f.measuredAt;
      // Waits for a running upload, so the old photo cannot overwrite the retake.
      await drive.exclusive(() => replacePhoto(p));
      candidate = null;
      await refresh();
      nav("dataset");
      toast("Retake saved · " + p.name);
      if (drive.connected() && navigator.onLine) syncNow().catch(fail);
      return;
    }
    await addPhoto(p);
    candidate = null;
    await refresh();
    render();
    window.scrollTo(0, 0);
    toast("Saved locally · " + p.name);
    if (drive.connected() && navigator.onLine) syncNow().catch(fail);
  } catch (e) {
    if (button.isConnected) button.disabled = false;
    throw e;
  }
}
async function syncNow() {
  if (!navigator.onLine)
    throw Error(
      "You are offline. Your saved photos remain queued on this device.",
    );
  if (!drive.connected())
    throw Error("Open Settings and connect Google Drive first.");
  try {
    await drive.sync((msg) => {
      syncMessage = msg;
      if ($("#syncStatus")) $("#syncStatus").textContent = msg;
    });
    await refresh();
    await loadSettings();
    if (page === "dataset" || page === "settings" || page === "home") render();
    toast(syncMessage);
    // Pick up what others changed, like a pull after a push.
    pullNow(true).catch(() => {});
  } catch (e) {
    syncMessage = "Upload paused: " + e.message;
    if ($("#syncStatus")) $("#syncStatus").textContent = syncMessage;
    throw e;
  }
}
// Switch dataset folder. Saved folder IDs belong to the old folder, so forget them.
// Photos already uploaded stay where they are.
async function useRoot(id) {
  if (photos.some((p) => !p.synced))
    throw Error("Sync or export your pending photos before switching folders.");
  await setting("datasetRoot", id || "");
  for (const x of await all("settings"))
    if (x.id.startsWith("folder:") || x.id === "driveRoot")
      await remove("settings", x.id);
  await loadSettings();
  render();
  toast(id ? "Dataset folder saved." : "Using the automatic dataset folder.");
  if (drive.connected() && navigator.onLine) await pullNow();
}
let pulling = false;
async function pullNow(quiet = false) {
  if (pulling) return;
  if (!navigator.onLine)
    throw Error("You are offline. Connect to load your Drive dataset.");
  if (!drive.connected())
    throw Error("Open Settings and connect Google Drive first.");
  pulling = true;
  const status = (msg) => {
    syncMessage = msg;
    if ($("#syncStatus")) $("#syncStatus").textContent = msg;
  };
  try {
    const r = await drive.pull(status);
    await refresh();
    await loadSettings();
    // Avoid redrawing over a photo review or a running camera.
    if (
      page === "dataset" ||
      page === "settings" ||
      page === "home" ||
      page === "capture"
    )
      render();
    if (!quiet || r.added || r.replaced || r.removed) toast(syncMessage);
  } catch (e) {
    status("Loading from Drive paused: " + e.message);
    throw e;
  } finally {
    pulling = false;
  }
}
async function loadSettings() {
  settingsCache = {
    client: await setting("client"),
    email: await setting("driveEmail"),
    root: await setting("driveRoot"),
    datasetRoot: await setting("datasetRoot"),
    rootInfo:
      drive.connected() && navigator.onLine ? await drive.rootInfo() : null,
    people:
      drive.connected() && navigator.onLine ? await drive.collaborators() : [],
  };
}
function download(blob, name) {
  const a = document.createElement("a"),
    u = URL.createObjectURL(blob);
  a.href = u;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(u), 120000);
}
async function exportZip(id) {
  await refresh();
  const selected = photos.filter((p) => id === "all" || p.run === id);
  if (!selected.length) throw Error("There are no photos to export yet.");
  const total = selected.reduce((n, p) => n + p.blob.size, 0);
  if (total > 900 * 1024 * 1024)
    throw Error(
      "This export is large for an iPhone. Export individual sessions to avoid running out of memory.",
    );
  const d = $("#modal");
  d.innerHTML =
    "<h2>Preparing your backup…</h2><p>Keep this page open. Your original photos and measured labels are being packaged.</p>";
  d.showModal();
  try {
    const selectedRuns = runs.filter((r) =>
        selected.some((p) => p.run === r.id),
      ),
      metadata = {
        schemaVersion: 1,
        exportedAt: new Date().toISOString(),
        runs: selectedRuns,
        photos: selected.map(({ blob, ...p }) => p),
      },
      files = selected.map((p) => ["BottleDataset/" + p.path, p.blob]);
    files.push(
      [
        "BottleDataset/labels.csv",
        new Blob([
          csv(
            selected.map((p) =>
              labelFor(
                p,
                runs.find((r) => r.id === p.run),
              ),
            ),
          ),
        ]),
      ],
      [
        "BottleDataset/index.json",
        new Blob([JSON.stringify(metadata, null, 2)]),
      ],
      [
        "BottleDataset/README.txt",
        new Blob([
          "Water mass dataset. Targets are approximate; water_mass_g is the measured training label. Keep related setup IDs in one split. JPEG orientation may be stored in EXIF. Preserve original photos. This backup includes all selected local photos whether or not they were uploaded. No camera or model accuracy is guaranteed.",
        ]),
      ],
    );
    const result = await zip(files),
      name =
        "BottleCapture_" +
        (id === "all" ? "all" : selectedRuns[0].session) +
        "_" +
        new Date().toISOString().slice(0, 10) +
        ".zip";
    d.innerHTML = `<h2>Your backup is ready.</h2><p>${selected.length} photos · ${(result.size / 1024 / 1024).toFixed(1)} MB<br>Includes organised folders, labels.csv and index.json.</p><div class="actions"><button class="btn" id="saveZip">Download ZIP</button><button class="btn secondary" id="shareZip">Share / Save to Files</button><button class="btn ghost" id="closeExport">Close</button></div><p class="tiny">Check the ZIP in Files or on your laptop before clearing any browser data.</p>`;
    $("#saveZip").onclick = () => download(result, name);
    const file = new File([result], name, { type: "application/zip" });
    if (!navigator.canShare?.({ files: [file] })) $("#shareZip").hidden = true;
    else
      $("#shareZip").onclick = () =>
        navigator
          .share({ files: [file], title: "BottleCapture dataset" })
          .catch((e) => {
            if (e.name !== "AbortError") fail(e);
          });
    $("#closeExport").onclick = () => d.close();
  } catch (e) {
    d.close();
    throw e;
  }
}
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    stopCamera();
    if (page === "shoot" && verified && !filePickerOpen) {
      verified = false;
      candidate = null;
      render();
    }
  }
});
window.addEventListener("offline", () =>
  toast("Offline. Keep this page open; photos can still be saved locally."),
);
window.addEventListener("online", () =>
  toast("Connection restored. Use Sync now to upload pending photos."),
);
window.addEventListener("beforeunload", (e) => {
  if (candidate) {
    e.preventDefault();
    e.returnValue = "";
  }
});
await refresh();
await loadSettings();
await drive.restore(settingsCache.client);
render();
// Bring in changes from other devices: on open, every 2 minutes, and when you return to the tab.
// Skipped while capturing or with a dialog open, so the screen never changes under you.
function autoPull() {
  if (
    drive.connected() &&
    navigator.onLine &&
    !document.hidden &&
    !["shoot", "new"].includes(page) &&
    !$("#modal").open
  )
    pullNow(true).catch(() => {});
}
autoPull();
setInterval(autoPull, 120000);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) autoPull();
});
