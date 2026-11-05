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
  PROTOCOL,
  spots,
  tagOptions,
  planFor,
  pickShot,
  shotText,
  shotWords,
  coverage,
  suggestTarget,
  fillGoal,
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
  correctFill,
  remove,
} from "./db.js";
import { zip } from "./zip.js";
import { referenceSvg } from "./refshot.js";
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
  refillPending = null,
  // A reading that looks wrong for a new fill (empty bottle, or far from the suggestion).
  farPending = null,
  // Protocol 2: suggested pour for a new fill, extra photos past the goal, imported batch.
  pendingTarget = null,
  extraShots = false,
  batch = null;
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
  batch = null;
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
// Drive login state for the top-right badge.
// "wanted": the user connected before and has not tapped Disconnect, so the login only expired.
const driveWanted = () =>
  !!settingsCache.wanted && !!settingsCache.client && !!settingsCache.email;
function reconnectBadge() {
  if (drive.connected())
    return '<span class="badge"><i class="dot"></i>Drive connected</span>';
  const waiting = photos.filter((p) => !p.synced).length;
  if (driveWanted() && navigator.onLine)
    return `<button class="badge warn" id="reconnectBadge"><i class="dot"></i>Tap to reconnect Drive${waiting ? ` · ${waiting} waiting` : ""}</button>`;
  return `<span class="badge warn"><i class="dot"></i>${navigator.onLine ? "Local collection" : "Offline"}${waiting ? ` · ${waiting} waiting` : ""}</span>`;
}
// For a new fill: is this balance reading likely a mistake?
function readingWarning(n) {
  if (!isV2(current) || retake || current.fills?.[level]) return "";
  const r = current,
    target = pendingTarget;
  if (n <= r.resolution && (target ?? 0) > r.resolution)
    return `That is the empty bottle weight (${grams(r.tare)} g), so the label would be 0 g water. Pour the water first, then weigh the filled bottle.`;
  if (
    target !== null &&
    Math.abs(n - target) > Math.max(0.25 * r.reference, 50)
  )
    return `The suggestion was about ${grams(target)} g. Hitting it is not required, but check the reading.`;
  return "";
}
function activeFill() {
  return retakeFill || current.fills[level];
}
function nextShot(r, l) {
  if (r.protocol === PROTOCOL) {
    const used = new Set(
      photos.filter((p) => p.run === r.id && p.level === l).map((p) => p.shot),
    );
    let i = 0;
    while (used.has(i)) i++;
    return i;
  }
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
    )}</nav><div class="sidebar-foot"><strong>A good dataset starts here.</strong>Keep the labels on. Measure every fill. Make every photo count.<hr class="divider">OTH Amberg-Weiden<br>Computer vision project</div></aside><main class="main"><div class="topbar"><span class="crumb">Workspace &nbsp; / &nbsp; <strong>Water in a bottle</strong></span><div class="brand mobile-brand"><span class="brand-icon">◒</span>BottleCapture</div><div class="topright">${reconnectBadge()}<span class="avatar">SA</span></div></div>${content}<div class="footer-note">BOTTLECAPTURE · MEASURE CAREFULLY. CAPTURE CONSISTENTLY. · VERSION __BUILD__</div></main></div>`;
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
  return `${header("Your next great dataset.", "A little structure. Better photos. More reliable research.", `<button class="btn" data-new="B04">${icon("plus")} New session</button>`)}<section class="hero"><div class="hero-copy"><div class="eyebrow">Built for your bottle project</div><h2>Weigh once.<br>Shoot everywhere.<br>Repeat.</h2><p>Pour a random amount, weigh it, then photograph the bottle in many spots of the creative space.</p><button class="btn light" data-new="B04">Start collecting ${icon("arrow")}</button></div><div class="hero-art">${bottles.map(bottleSvg).join("")}</div></section><div class="stats"><div class="stat"><div class="stat-top">Photos collected ${iconSmall("capture")}</div><strong>${photos.length.toLocaleString()}</strong><small>${runs.reduce((n, r) => n + (r.archived ? 0 : Object.keys(r.fills || {}).length), 0)} measured fills so far</small></div><div class="stat"><div class="stat-top">Bottles covered ${iconSmall("dataset")}</div><strong>${new Set(photos.map((p) => runs.find((r) => r.id === p.run)?.bottle)).size}<span class="muted" style="font-size:16px"> / 4</span></strong><small>Each bottle has its own identity</small></div><div class="stat"><div class="stat-top">Saved to Drive ${iconSmall("cloud")}</div><strong>${synced}</strong><small>${photos.length - synced} photos waiting to sync</small></div><div class="stat"><div class="stat-top">Sessions ${iconSmall("check")}</div><strong>${runs.length}</strong><small>${runs.filter((r) => done(r) === 11 * countShots(r)).length} fully photographed</small></div></div><div class="section-head"><h2>Your four bottles</h2><small>Select a bottle to begin</small></div><div class="bottles">${bottles
    .map((b) => {
      const n = photos.filter(
        (p) => runs.find((r) => r.id === p.run)?.bottle === b.id,
      ).length;
      const fills = bottleFills(b.id, "train").length,
        ref = runs.find((r) => r.bottle === b.id)?.reference;
      return `<button class="bottle-card" data-new="${b.id}"><div class="bottle-stage"><span class="bottle-code">${b.id}</span>${bottleSvg(b)}</div><h3>${b.name}</h3><p>${b.detail}</p><div class="progress"><i style="width:${Math.min((fills / fillGoal.train) * 100, 100)}%"></i></div><div class="card-foot"><span>${fills} / ${fillGoal.train} training fills · ${n} photos</span><span>Start →</span></div>${ref ? coverageStrip(b.id, "train", ref) : ""}</button>`;
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
  }</section><section class="panel soft"><div class="eyebrow">Before the first shutter</div><h3>Three things to get right.</h3><ol class="steps"><li><strong>Shoot in the creative space.</strong> That is where every test image is taken.</li><li><strong>Weigh every fill.</strong> The balance reading is the label.</li><li><strong>Move around.</strong> New spot, new side of the label, new height, every photo.</li></ol><button class="text-link" data-nav="guide">Read the collection guide →</button></section></div>`;
}
function iconSmall(n) {
  return `<span style="width:15px;height:15px;display:inline-flex">${icon(n)}</span>`;
}
function runRow(r) {
  const b = bottles.find((b) => b.id === r.bottle);
  return `<div class="row"><div><strong>${esc(r.session)}${r.archived ? " (archived)" : ""} · ${b.name}</strong><small>${esc(r.instance)} · ${esc(r.split)} · ${isV2(r) ? `${fillKeys(r).length} fills · ${done(r)} photos` : `${done(r)} / ${11 * countShots(r)} photos`}${foreign(r) ? " · by " + esc(r.uploadedBy) : ""}</small></div><div class="actions"><button class="btn small secondary" data-run="${r.id}">${r.archived ? "View archived attempt" : "Open session"}</button>${!r.archived ? `<button class="btn small" data-resume="${r.id}">Continue photos</button>` : ""}</div></div>`;
}
function sessions() {
  return `${header("Collection sessions.", "Resume where you stopped, or start an independent setup.", `<button class="btn" data-new="B04">${icon("plus")} New session</button>`)}<div class="notice">Goal per bottle: about ${fillGoal.train} training fills × 8 photos, plus ${fillGoal.validation} validation and ${fillGoal.holdout} holdout fills × 4 photos, collected on other days. The professor's datasets stay separate.</div><section class="panel">${runs.length ? runs.map(runRow).join("") : `<div class="empty"><h2>Your workspace is ready.</h2><p>Create a session and the app will guide every shot.</p><button class="btn" data-new="B04">Start your first session</button></div>`}</section>`;
}
let selectedBottle = "B04";
function field(label, name, value = "", help = "", type = "text") {
  return `<label class="field">${label}<input name="${name}" value="${esc(value)}" ${type === "decimal" ? 'inputmode="decimal"' : `type="${type}"`} required>${help ? `<small>${help}</small>` : ""}</label>`;
}
function newSession() {
  const last = runs.find((r) => r.bottle === selectedBottle && !r.archived),
    v = last || {};
  return `${header("Start a collection session.", "One session = one visit with one physical bottle. You weigh many fills inside it.")}<form id="sessionForm"><div class="grid2"><section class="panel"><div class="eyebrow">01 · Bottle</div><h2>Which bottle?</h2><hr class="divider"><label class="field">Bottle type<select name="bottle">${bottles.map((b) => `<option value="${b.id}" ${selectedBottle === b.id ? "selected" : ""}>${b.id} · ${b.name} · ${b.detail}</option>`).join("")}</select></label><div class="grid2">${field("Physical bottle ID", "instance", v.instance || "I01", "Each real bottle gets its own ID. Use I02, I03 for other bottles of the same type.")}${field("Session label", "session", "S" + String(runs.length + 1).padStart(2, "0"), "A new visit, a new label.")}</div><label class="field">Dataset split<select name="split"><option value="train">Training · ~8 photos per fill</option><option value="validation">Internal validation · ~4 photos per fill</option><option value="holdout">Internal holdout · ~4 photos per fill</option></select><small>Collect validation and holdout on a different day from training.</small></label><label class="field">Where<select name="background"><option>Creative space DC 3rd floor</option><option>Other room</option></select><small>The professor's validation, test and live images are all taken in the creative space. Collect there.</small></label><label class="field">Light today<select name="lighting"><option>Daylight</option><option>Overcast daylight</option><option>Ceiling lights (evening)</option><option>Mixed</option></select></label><details><summary class="text-link">Advanced: leakage group</summary>${field("Setup / leakage group", "setup", "S" + String(runs.length + 1).padStart(2, "0"), "Defaults to the session label. Photos with one setup ID always stay in one split.")}</details></section><section class="panel"><div class="eyebrow">02 · Measure once per bottle</div><h2>Balance readings</h2><hr class="divider">${field("Empty bottle + cap (g)", "tare", v.tare ?? "", "Dry, empty, original label and cap on. Filled in from your last session with this bottle.", "decimal")}${field("Full-reference water only (g)", "reference", v.reference ?? "", "Water mass at a normal full fill (not to the brim). Used only to suggest pours and check typos.", "decimal")}${field("Balance step (g)", "resolution", v.resolution ?? "1", "Smallest step the balance shows, e.g. 1 or 0.1.", "decimal")}<div class="notice">Water mass = filled bottle with cap − empty bottle with cap. Always weigh with the same cap.</div><button class="btn" type="submit">Create session ${icon("arrow")}</button></section></div></form>`;
}
// Fill in the bottle's measurements from its last session, so they stay identical.
function prefillSession(e) {
  const form = $("#sessionForm"),
    bottle = form.elements.bottle.value;
  if (e.target.name === "bottle") {
    const last = runs.find((r) => r.bottle === bottle);
    form.elements.instance.value = last?.instance || "I01";
  }
  const instance = form.elements.instance.value.trim(),
    last = runs.find((r) => r.bottle === bottle && r.instance === instance);
  form.elements.tare.value = last?.tare ?? "";
  form.elements.reference.value = last?.reference ?? "";
  form.elements.resolution.value = last?.resolution ?? "1";
}
function retakeTags() {
  if (!retake) return null;
  return photos.find((p) => p.id === retake.id) || null;
}
function sessionPage() {
  return isV2(current) ? v2SessionPage() : legacySessionPage();
}
function legacySessionPage() {
  const r = current,
    b = bottles.find((b) => b.id === r.bottle);
  return `${header(`${b.name} · ${esc(r.session)}`, `${esc(r.split)} · ${esc(r.instance)} · ${esc(r.background)}`, `<button class="btn secondary" data-nav="capture">${icon("back")} Sessions</button>`)}<div class="grid2"><section class="panel"><div class="eyebrow">Session progress</div><h2>${done(r)} <span class="muted">/ ${11 * countShots(r)} photos</span></h2><p>${countShots(r)} views at each of 11 fill levels.</p><div class="progress"><i style="width:${(done(r) / (11 * countShots(r))) * 100}%"></i></div>${foreign(r) ? `<p class="tiny">Started by ${esc(r.uploadedBy)}. You can add, retake and delete photos here too.</p>` : ""}<div class="actions">${!r.archived ? `<button class="btn small" data-resume="${r.id}">Continue photos</button><button class="btn small secondary" id="resetSession">Reset session</button>` : '<span class="badge">Archived attempt</span>'}<button class="btn small secondary" data-export="${r.id}">${icon("download")} Export session ZIP</button><button class="btn small danger" id="deleteSession">Delete session</button></div></section><section class="panel soft"><div class="eyebrow">Your measurement reference</div><h2>${grams(r.reference)} g <span class="muted" style="font-size:13px">water at 100%</span></h2><p>Empty bottle + cap: ${grams(r.tare)} g<br>Scale step: ${grams(r.resolution)} g · Setup: ${esc(r.setup)}</p></section></div><div class="section-head"><h2>Choose a fill level</h2><small>Actual grams are recorded next</small></div><div class="levels">${Array.from({ length: 11 }, (_, l) => `<button class="level ${done(r, l) === countShots(r) ? "complete" : ""}" data-level="${l}" ${r.archived ? "disabled" : ""}><strong>${l * 10}%</strong><small>Target ≈ ${grams((r.reference * l) / 10)} g</small><small>${done(r, l)} / ${countShots(r)} photos ${done(r, l) === countShots(r) ? "✓" : ""}</small></button>`).join("")}</div><div class="notice">Targets help you choose fills. The exact balance reading becomes the training label. Let the water settle and wipe the outside dry. If you refill a level after leaving the setup, start a new session instead of reusing its old measurement.</div>`;
}
function angleDiagram(s) {
  return `<div class="angle-diagram"><svg viewBox="0 0 300 145" aria-label="Camera framing illustration"><path d="M40 130h220" stroke="#c5d1b8"/><path d="M179 25h15v30l12 14v57h-39V69l12-14z" fill="#d3e0c5" stroke="#7c9870" stroke-width="2"/><path d="M169 91h35v21h-35z" fill="#fafbf7"/><g transform="translate(${s === 0 || s === 4 || s === 5 || s === 9 ? "45 70" : "60 20"}) rotate(${s === 0 || s === 4 || s === 5 || s === 9 ? "0" : "25"})"><rect width="34" height="24" rx="5" fill="#315c46"/><circle cx="18" cy="12" r="6" fill="#e6eed8"/><path d="M42 12h65" stroke="#91a782" stroke-dasharray="4 4"/></g><text x="150" y="143" text-anchor="middle" font-size="9" fill="#6e8268">${shots[s][3]} · whole bottle in frame</text></svg></div>`;
}
function shootPage() {
  return isV2(current) ? v2ShootPage() : legacyShootPage();
}
function legacyShootPage() {
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
        `<article class="photo-tile"><img src="${objectURL(p.blob)}" alt="${esc(p.name)}" loading="lazy"><div class="info"><div class="bar"><strong>${grams(p.mass)} g</strong><span class="badge ${p.synced ? "" : "warn"}">${p.synced ? "On Drive" : "Local"}</span></div><p>${esc(p.name)}</p><p>${p.spot ? esc(p.spot) + " · " + esc(p.facing || "") + " · " : ""}${esc(p.visibility)} surface · ${p.width} × ${p.height}${p.retakenAt ? " · retaken" : ""}</p><button class="text-link" data-photo="${p.id}">View, retake or download</button></div></article>`,
    )
    .join("");
}
function guide() {
  return `${header("The field guide.", "Collect photos that look like the professor's test photos.")}<div class="grid2"><section class="panel"><div class="eyebrow">What the validation set shows</div><h2>Test photos are messy on purpose.</h2><ol class="steps"><li><strong>Many places.</strong> Desks, chairs, window sills, shelves, carpet, plants, boxes, all in the creative space on DC 3rd floor.</li><li><strong>Any side of the bottle.</strong> Front label, back label and side views.</li><li><strong>Loose camera angles.</strong> Low, bottle height and from above. Near and far.</li><li><strong>Sometimes held in a hand.</strong> Still upright.</li><li><strong>Random masses.</strong> From about 3 g to over 900 g, not round steps.</li><li><strong>Several bottles of each type.</strong> Caps and wear differ.</li></ol></section><section class="panel soft"><div class="eyebrow">The protocol</div><h2>Weigh once. Shoot everywhere.</h2><ol class="steps"><li><strong>Weigh the empty bottle with its cap</strong> once per physical bottle.</li><li><strong>Tap “Weigh a new fill”.</strong> Pour roughly the suggested amount. Weigh. Enter the reading.</li><li><strong>Take about 8 photos</strong> (4 for validation and holdout). Follow the prompt: a new spot, a new side, a new height.</li><li><strong>Tag each photo.</strong> It takes a few taps. Tags show you later where the model fails.</li><li><strong>Pour some in or out, weigh again.</strong> That is the next fill.</li><li><strong>Spread fills evenly.</strong> The coverage bars show which amounts are missing. The suggestions fill the gaps.</li></ol></section></div><div class="grid2"><section class="panel"><div class="eyebrow">Do</div><h3>Good habits</h3><ol class="steps"><li>Keep the original labels and cap on.</li><li>Whole bottle visible, cap to base, in sharp focus.</li><li>Use the normal 1× lens. No flash, no portrait mode, no filters.</li><li>Let the water settle before each photo.</li><li>Use 2–3 physical bottles per type (I01, I02…).</li><li>Shoot on different days and at different times of day.</li></ol></section><section class="panel"><div class="eyebrow">Don't</div><h3>Shortcuts the model could learn</h3><ol class="steps"><li>No balance, jug, cups or written numbers in the photo.</li><li>Don't always pour in order from empty to full. The suggestions are random for this reason.</li><li>Don't photograph a fill in only one spot.</li><li>Don't delete “behind label” photos. They are in the test set too.</li><li>Never mix photos of one fill into training and evaluation. The app keeps each fill inside its session.</li></ol></section></div><section class="panel"><h3>A realistic plan</h3><div class="grid2"><div><p><strong>Per visit (about 1 hour):</strong> one bottle, 10–15 fills, about 100 photos. Batch import helps: shoot with the phone camera, then import all photos of one fill at once.</p><p><strong>Goal per bottle:</strong> about ${fillGoal.train} training fills, then ${fillGoal.validation} validation and ${fillGoal.holdout} holdout fills on other days.</p></div><div><p><strong>Check early:</strong> after the first visit, train a quick model and score it on the professor's 40 validation photos. Let the errors decide what to collect next.</p><p class="tiny">No number of photos guarantees accuracy. When the water line is behind the label, the photo may not contain enough information.</p></div></div></section>`;
}
// ---------- Protocol 2: free fills, many spots, tagged photos ----------
const isV2 = (r) => r?.protocol === PROTOCOL;
const fillKeys = (r) =>
  Object.keys(r.fills || {})
    .map(Number)
    .sort((a, b) => a - b);
function nextFill(r) {
  const k = fillKeys(r);
  return k.length ? k[k.length - 1] + 1 : 1;
}
// Fills of this bottle in this split across live sessions, for balanced targets.
function bottleFills(bottle, split) {
  return runs
    .filter(
      (x) =>
        x.bottle === bottle && !x.archived && (!split || x.split === split),
    )
    .flatMap((x) => Object.values(x.fills || {}));
}
function coverageStrip(bottle, split, reference) {
  const c = coverage(bottleFills(bottle, split), reference),
    max = Math.max(1, ...c);
  return `<div class="cov" aria-label="Fill coverage from empty to full">${c
    .map(
      (n, i) =>
        `<div class="cov-col" title="${i * 10}–${i * 10 + 10}%: ${n} fills"><i style="height:${Math.max(4, (n / max) * 100)}%" class="${n ? "" : "none"}"></i><small>${n}</small></div>`,
    )
    .join(
      "",
    )}</div><div class="cov-axis"><span>empty</span><span>half</span><span>full</span></div>`;
}
function chips(name, options, value, required = false) {
  return `<div class="chips" role="radiogroup">${options
    .map(
      ([v, t]) =>
        `<label class="chip"><input type="radio" name="${name}" value="${esc(v)}" ${v === value ? "checked" : ""} ${required ? "required" : ""}><span>${esc(t)}</span></label>`,
    )
    .join("")}</div>`;
}
const spotOptions = () => spots.map((s) => [s, s]);
const visibilityOptions = [
  ["visible", "Visible"],
  ["partial", "Partly"],
  ["hidden", "Behind label"],
  ["uncertain", "Not sure"],
];
function fillPhotos(r, l) {
  return photos
    .filter((p) => p.run === r.id && p.level === l)
    .sort((a, b) => a.shot - b.shot);
}
function lastSpot(r, l) {
  const list = fillPhotos(r, l);
  return list.length ? list[list.length - 1].spot : undefined;
}
function v2SessionPage() {
  const r = current,
    b = bottles.find((b) => b.id === r.bottle),
    keys = fillKeys(r),
    goal = countShots(r);
  return `${header(`${b.name} · ${esc(r.session)}`, `${esc(r.split)} · ${esc(r.instance)} · ${esc(r.background)} · ${esc(r.lighting)}`, `<button class="btn secondary" data-nav="capture">${icon("back")} Sessions</button>`)}<div class="grid2"><section class="panel"><div class="eyebrow">This session</div><h2>${keys.length} fills <span class="muted">· ${done(r)} photos</span></h2><p>Weigh a fill, take about ${goal} photos in different spots, then weigh the next one.</p>${foreign(r) ? `<p class="tiny">Started by ${esc(r.uploadedBy)}. You can add, retake and delete photos here too.</p>` : ""}<div class="actions">${!r.archived ? `<button class="btn" data-newfill="1">${icon("plus")} Weigh a new fill</button><button class="btn secondary small" id="resetSession">Reset session</button>` : '<span class="badge">Archived attempt</span>'}<button class="btn small secondary" data-export="${r.id}">${icon("download")} Export session ZIP</button><button class="btn small danger" id="deleteSession">Delete session</button></div></section><section class="panel soft"><div class="eyebrow">${b.id} · ${esc(r.split)} fills across all sessions</div><h3>Coverage from empty to full</h3>${coverageStrip(r.bottle, r.split, r.reference)}<p class="tiny">Full reference: ${grams(r.reference)} g water. Empty bottle + cap: ${grams(r.tare)} g. Scale step: ${grams(r.resolution)} g. The app suggests pours for the emptiest bars.</p></section></div><div class="section-head"><h2>Fills in this session</h2><small>Each fill is one balance reading</small></div>${
    keys.length
      ? `<div class="levels">${[...keys]
          .reverse()
          .map((l) => {
            const f = r.fills[l],
              n = done(r, l);
            return `<button class="level ${n >= goal ? "complete" : ""}" data-fill="${l}" ${r.archived ? "disabled" : ""}><strong>${grams(f.mass)} g</strong><small>F${String(l).padStart(2, "0")} · ${Math.round((f.mass / r.reference) * 100)}% full</small><small>${n} / ${goal} photos ${n >= goal ? "✓" : ""}</small></button>`;
          })
          .join("")}</div>`
      : `<section class="panel empty"><h3>No fills yet.</h3><p>Tap “Weigh a new fill”. The app suggests how much water to pour.</p></section>`
  }<div class="notice">Tap a fill to add more photos. You only confirm that the water has not changed. If you pour water in or out, that is a new fill.</div>`;
}
function v2ShootPage() {
  const r = current,
    goal = countShots(r),
    f = verified ? activeFill() : r.fills?.[level],
    n = done(r, level),
    fillName = `F${String(level).padStart(2, "0")}`;
  // 1. Weigh a new fill, or confirm an existing one.
  if (!verified) {
    if (!f && pendingTarget === null)
      pendingTarget = suggestTarget(
        r.reference,
        bottleFills(r.bottle, r.split),
      );
    const sameBlock = f
      ? `<div class="notice">This fill was weighed at <strong>${grams(f.mass)} g</strong> water (${grams(f.gross)} g on the balance). If you have not poured anything in or out, continue straight away.</div><label class="check"><input type="checkbox" id="sameWaterOk">I have not added or removed water since then.</label><button class="btn" type="button" id="sameWater" disabled>Continue with ${grams(f.mass)} g ${icon("arrow")}</button><button class="text-link" id="correctFill">Saved weight is wrong? Correct it</button><hr class="divider"><h3>Not sure? Weigh again</h3>`
      : "";
    return `${header(
      retake
        ? `Retake · ${fillName} · photo ${retake.shot + 1}`
        : f
          ? `${fillName} · ${grams(f.mass)} g`
          : `New fill · pour about ${grams(pendingTarget)} g`,
      f
        ? "Confirm the water is unchanged, then keep shooting."
        : `About ${Math.round((pendingTarget / r.reference) * 100)}% of the full reference. Hitting it exactly does not matter. The balance reading is the label.`,
    )}<div class="grid2"><section class="panel">${sameBlock}<p>${f ? "The reading must match within one scale step." : "Pour water, put the same cap on, dry the outside, then weigh. Enter exactly what the balance shows."}</p><form id="massForm">${field("Filled bottle + cap (g)", "gross", "", "Empty bottle + cap: " + grams(r.tare) + " g", "decimal")}<div id="massPreview" class="notice">Your net water mass will appear here.</div><button class="btn" type="submit" id="massSubmit">Confirm & start photos ${icon("arrow")}</button></form>${!f ? '<button class="text-link" id="newTarget">Suggest a different amount</button>' : ""}<br><button class="text-link" id="backSession">${retake ? "← Cancel retake" : "← Back to session"}</button></section><section class="panel soft"><h3>Why random amounts?</h3><p>The professor's test masses are spread out: 3 g, 36 g, 137 g, 467 g and so on. Random pours teach the model the whole range, not eleven fixed steps.</p><h3>Coverage so far</h3>${coverageStrip(r.bottle, r.split, r.reference)}</section></div>`;
  }
  // 2. Enough photos of this fill: offer the next step.
  if (!retake && n >= goal && !extraShots)
    return `${header(`${fillName} done · ${grams(f.mass)} g`, `${n} photos saved. Now change the water and weigh the next fill.`)}<section class="panel"><div class="actions"><button class="btn" data-newfill="1">${icon("plus")} Weigh the next fill</button><button class="btn secondary" id="moreShots">Take more of this fill</button><button class="btn ghost" id="correctFill">Correct weight</button><button class="btn ghost" id="backSession">Back to session</button></div><p class="tiny">${photos.filter((p) => p.run === r.id && p.level === level && !p.synced).length} photos of this fill still need a Drive upload or local export.</p></section>`;
  // 3. Shoot.
  const shot = retake ? retake.shot : nextShot(r, level);
  activeShot = shot;
  const pl = shotPlan(r, level, shot),
    used = [
      ...new Set(
        fillPhotos(r, level)
          .map((p) => p.spot)
          .filter(Boolean),
      ),
    ];
  return `${header(`${retake ? "Retake · " : ""}${fillName} · photo ${shot + 1}${retake ? "" : ` of ~${goal}`}`, `Water: ${grams(f.mass)} g · The model only sees the photo.`, `${retake ? "" : '<button class="btn ghost small" id="correctFill">Correct weight</button>'}<button class="btn secondary small" id="backSession">${retake ? "Cancel retake" : "Pause"}</button>`)}${retake ? '<div class="notice warn">Retake mode. When you save, this photo replaces the old one here and on Google Drive. The old Drive files move to Drive Trash.</div>' : ""}<div class="capture-layout"><section><div id="cameraStage"><div class="viewfinder" id="viewfinder"><div class="cam-placeholder">${icon("capture")}<p style="color:#b7c8b7">${esc(pl.text)}</p><button class="btn light" id="startCamera">Open live camera</button><p class="tiny" style="color:#a8baaa">Or use the phone camera below for a full-resolution photo.</p></div></div><div id="cameraControls"></div></div><label class="btn" style="width:100%;margin:12px 0 6px;cursor:pointer">${icon("capture")} Take photo with phone camera<input id="fileCamera" type="file" accept="image/*" capture="environment" hidden></label>${retake ? "" : `<label class="btn secondary" style="width:100%;margin:0 0 12px;cursor:pointer">${icon("dataset")} Import several photos of this fill<input id="fileBatch" type="file" accept="image/*" multiple hidden></label>`}<div id="review"></div></section><section class="panel instruction-panel"><div class="eyebrow">Next shot</div><figure class="ref-shot">${referenceSvg(pl, pl.words)}<figcaption>${esc(pl.words)}</figcaption></figure><h2 class="instruction">${esc(pl.text)}</h2>${retake ? "" : '<button class="text-link" id="otherShot">Can’t do this one? Show a different shot</button>'}<ol class="steps"><li>Bottle upright, original label on, cap on.</li><li>Whole bottle in the frame, cap to base. A busy background is fine.</li><li>No balance, jug, cups or written numbers in view.</li><li>Tap to focus on the bottle. Normal 1× lens. No flash, no portrait mode.</li></ol><p class="tiny">Spots used for this fill: ${used.length ? used.map(esc).join(", ") : "none yet"}. Aim for at least four different spots per fill.</p><div class="eyebrow">Assigned filename</div><div class="filename">${photoName(r, level, shot)}</div></section></div>`;
}
// The reference shot for one photo: a random combination of spot, label side,
// camera height and distance. Never repeats inside the fill, avoids the bottle's
// recent fills. Stays the same until a photo is saved or "Show a different shot".
// A retake shows how the original photo was tagged.
const shotSkip = {};
const tagsOf = (p) =>
  p?.spot && p.facing && p.camHeight && p.distance
    ? {
        spot: p.spot,
        facing: p.facing,
        camHeight: p.camHeight,
        distance: p.distance,
      }
    : null;
function shotPlan(r, l, shot) {
  const own = retake ? tagsOf(retakeTags()) : null;
  if (own) return { ...own, text: shotText(own), words: shotWords(own) };
  const inFill = fillPhotos(r, l)
      .filter((p) => p.shot !== shot)
      .map(tagsOf)
      .filter(Boolean),
    recent = photos
      .filter(
        (p) =>
          !(p.run === r.id && p.level === l) &&
          runs.find((x) => x.id === p.run)?.bottle === r.bottle,
      )
      .sort((a, b) => (b.takenAt || "").localeCompare(a.takenAt || ""))
      .slice(0, 40)
      .map(tagsOf)
      .filter(Boolean),
    key = `${r.id}:${l}:${shot}`;
  return pickShot({ seed: `${key}:${shotSkip[key] || 0}`, inFill, recent });
}
function tagForm(pl, spot, batch) {
  const mixed = batch ? [["mixed", "Mixed"]] : [];
  return `<label class="field">Where is the bottle?${chips("spot", spotOptions(), spot, true)}</label><label class="field">Which side faces the camera?${chips("facing", [...mixed, ...tagOptions.facing], batch ? "mixed" : pl.facing, true)}</label><label class="field">Camera height${chips("camHeight", [...mixed, ...tagOptions.camHeight], batch ? "mixed" : pl.camHeight, true)}</label><label class="field">Distance${chips("distance", [...mixed, ...tagOptions.distance], batch ? "mixed" : pl.distance, true)}</label><label class="field">Water surface${chips("visibility", visibilityOptions, batch ? "uncertain" : "", true)}<small>Look at the photo. “Behind label” examples stay in the dataset.</small></label>`;
}
function readTags(form) {
  const d = new FormData(form),
    t = {
      spot: d.get("spot"),
      facing: d.get("facing"),
      camHeight: d.get("camHeight"),
      distance: d.get("distance"),
      visibility: d.get("visibility"),
    };
  if (!t.spot) throw Error("Choose where the bottle is.");
  if (!["visible", "partial", "hidden", "uncertain"].includes(t.visibility))
    throw Error("Choose the water surface visibility.");
  return t;
}
async function decodePhoto(file) {
  if (file.size > 60 * 1024 * 1024)
    throw Error("Choose photos smaller than 60 MB.");
  const img = new Image(),
    u = objectURL(file);
  img.src = u;
  try {
    await img.decode();
  } catch {
    throw Error(
      "A photo could not be decoded. On iPhone choose Camera → Formats → Most Compatible, or select JPEGs.",
    );
  }
  let blob = file;
  if (file.type !== "image/jpeg") {
    const c = document.createElement("canvas");
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    c.getContext("2d").drawImage(img, 0, 0);
    blob = await new Promise((r) => c.toBlob(r, "image/jpeg", 0.97));
    if (!blob) throw Error("Could not convert a photo to JPEG.");
  }
  return {
    blob,
    width: img.naturalWidth,
    height: img.naturalHeight,
    takenAt: file.lastModified
      ? new Date(file.lastModified).toISOString()
      : new Date().toISOString(),
  };
}
async function prepareBatch(files) {
  stopCamera();
  const list = [];
  for (const [i, file] of files.entries()) {
    $("#review").innerHTML =
      `<section class="panel"><p>Reading photo ${i + 1} of ${files.length}…</p></section>`;
    list.push(await decodePhoto(file));
  }
  batch = { run: current.id, level, list };
  const pl = planFor(level, nextShot(current, level));
  $("#review").innerHTML =
    `<section class="panel"><div class="eyebrow">Review ${list.length} photos</div><h3>${grams(activeFill().mass)} g each · ${fillLabel()}</h3><div class="batch-grid">${list.map((c) => `<img src="${objectURL(c.blob)}" alt="Imported bottle photo">`).join("")}</div>${list.some((c) => Math.min(c.width, c.height) < 1000) ? '<div class="notice warn">Some photos have low resolution.</div>' : ""}<div class="notice warn">Import only photos of this exact fill. Imported photos share the tags you choose here.</div><form id="batchForm">${tagForm(pl, "", true)}<div class="actions"><button class="btn" type="submit" id="saveBatch">Save ${list.length} photos ${icon("arrow")}</button><button class="btn secondary" type="button" id="cancelBatch">Cancel</button></div></form></section>`;
  on("#batchForm", "submit", saveBatch);
  $("#cancelBatch").onclick = () => {
    batch = null;
    render();
  };
  $("#review").scrollIntoView({ behavior: "smooth", block: "start" });
}
const fillLabel = () => `F${String(level).padStart(2, "0")}`;
async function saveBatch(e) {
  e.preventDefault();
  if (!batch) throw Error("Choose photos first.");
  const button = $("#saveBatch");
  button.disabled = true;
  try {
    if (batch.run !== current.id || batch.level !== level || !verified)
      throw Error("Reconfirm the fill before saving.");
    const t = readTags(e.target),
      f = activeFill();
    let saved = 0;
    const used = new Set(
      photos
        .filter((p) => p.run === current.id && p.level === level)
        .map((p) => p.shot),
    );
    for (const c of batch.list) {
      let shot = 0;
      while (used.has(shot)) shot++;
      used.add(shot);
      await addPhoto({
        id: `${current.id}:${level}:${shot}`,
        run: current.id,
        level,
        shot,
        name: photoName(current, level, shot),
        path: photoPath(current, level, shot),
        mass: f.mass,
        gross: f.gross,
        target: f.target,
        ...t,
        blob: c.blob,
        width: c.width,
        height: c.height,
        takenAt: c.takenAt,
        imported: true,
        synced: false,
      });
      saved++;
    }
    batch = null;
    await refresh();
    render();
    window.scrollTo(0, 0);
    toast(`Saved ${saved} photos locally.`);
    if (drive.connected() && navigator.onLine) syncNow().catch(fail);
  } catch (e) {
    if (button.isConnected) button.disabled = false;
    await refresh();
    throw e;
  }
}
let settingsCache = {};
function settings() {
  return `${header("Make the studio yours.", "Connect storage, protect your dataset and keep collecting.")}<div class="grid2"><section class="panel"><div class="bar"><h2>Google Drive</h2><span class="badge ${drive.connected() ? "" : "warn"}">${drive.connected() ? "Connected" : "Setup / reconnect"}</span></div><p>Save & Next uploads the approved photo and its measured-mass JSON record into the “BottleCapture Dataset” folder, yours or one shared with you.</p><form id="driveForm">${field("Google OAuth web client ID", "client", settingsCache.client || "", "A public client ID ending in .apps.googleusercontent.com. Never enter a client secret.")}<button class="btn secondary" type="submit">Save client ID</button></form><div class="actions"><button class="btn" id="connectDrive">${icon("cloud")} Connect Google Drive</button><button class="btn secondary" id="syncNow">Sync pending</button><button class="btn secondary" id="pullDrive">Load from Drive</button>${drive.connected() ? '<button class="btn ghost" id="disconnectDrive">Disconnect</button>' : ""}</div><p class="tiny">${settingsCache.email ? "Dataset account: " + esc(settingsCache.email) : "Connect once. If the login expires, tap the Reconnect badge at the top."}</p>${settingsCache.root ? `<a class="text-link" href="https://drive.google.com/drive/folders/${encodeURIComponent(settingsCache.root)}" target="_blank" rel="noopener">Open your Drive dataset ↗</a>` : ""}<p id="syncStatus" class="sync-status">${esc(syncMessage)}</p><hr class="divider"><h3>Shared dataset folder</h3><p class="tiny">${settingsCache.rootInfo ? `Uploading into “${esc(settingsCache.rootInfo.name)}”, owned by ${esc(settingsCache.rootInfo.owners?.[0]?.emailAddress || "unknown")}.${settingsCache.rootInfo.capabilities?.canAddChildren === false ? " You only have view access: ask the owner to make you an Editor." : ""}` : "Connect Drive to see which dataset folder this device uses."} A folder someone shared with you is found automatically. To pick a different one, paste its Drive link.</p>${lonely() ? `<div class="notice warn">Only you can see this folder. If your partner started the dataset, ask them to invite <strong>${esc(settingsCache.email)}</strong> in their Settings. If you started it, invite your partner below.</div>` : ""}<h3>People on this dataset</h3><ul class="steps">${(settingsCache.people || []).map((x) => `<li>${esc(x.emailAddress || x.displayName)} · ${x.role === "owner" ? "owner" : x.role === "writer" ? "can edit" : esc(x.role)}${x.role !== "owner" && settingsCache.rootInfo?.ownedByMe ? ` <button class="text-link" data-uninvite="${esc(x.id)}" data-who="${esc(x.emailAddress || x.displayName)}">Remove</button>` : ""}</li>`).join("") || "<li>Connect Drive to see who has access.</li>"}</ul>${settingsCache.rootInfo?.capabilities?.canShare !== false && settingsCache.rootInfo ? `<form id="inviteForm">${field("Invite a partner (Google email)", "email", "", "They get edit access and an email from Google. Use the exact address they connect with.", "email")}<button class="btn small" type="submit">Invite as editor</button></form>` : ""}<form id="rootForm">${field("Dataset folder link (optional)", "root", "", "Example: https://drive.google.com/drive/folders/…")}<div class="actions"><button class="btn secondary small" type="submit">Use this folder</button>${settingsCache.datasetRoot ? '<button class="btn ghost small" type="button" id="clearRoot">Use automatic folder</button>' : ""}</div></form><details><summary class="text-link">Add a friend who captures on his own phone</summary><ol class="steps"><li>In Google Cloud Console → Google Auth Platform → Audience, add your friend’s Google email as a <strong>test user</strong>.</li><li>In Google Drive, share the “BottleCapture Dataset” folder with your friend as <strong>Editor</strong>.</li><li>Your friend opens this site, pastes the same client ID in Settings, and connects with his own Google account.</li><li>The app finds the shared folder. You both work on one central dataset: new photos, retakes and deletes from either phone show up on every device within a couple of minutes.</li><li>His uploads use his own Google storage. Give his physical bottle its own instance ID (for example I02).</li></ol></details><details><summary class="text-link">One-time Google setup instructions</summary><ol class="steps"><li>Open <a href="https://console.cloud.google.com/" target="_blank" rel="noopener">Google Cloud Console</a> on your laptop. Create a project called BottleCapture.</li><li>Enable the <strong>Google Drive API</strong>.</li><li>Configure Google Auth Platform: your app name, contact email, and audience. For a personal external testing app, add your own Google email as a test user.</li><li>Create an OAuth client with application type <strong>Web application</strong>.</li><li>Add this exact <strong>Authorized JavaScript origin</strong>:<div class="filename">${esc(location.origin)}</div></li><li>Copy the client ID here, save it, and tap Connect Google Drive. No client secret or redirect URI is needed for this browser token flow.</li><li>Allow access to Google Drive. Full Drive access is needed so two Google accounts can work in one shared folder. The app only reads and writes inside the BottleCapture Dataset folder. Take one pilot photo and confirm both its JPEG and JSON arrive before a full session.</li></ol><p class="tiny">Google may require additional consent-screen configuration. Your password stays with Google; your Google login is kept in this browser until it expires (about 1 hour) or you tap Disconnect, and is renewed quietly or with one tap, separate from the dataset.</p></details></section><section class="panel"><h2>Local safety net</h2><p>Approved photos are saved in this browser before uploading. Keep this tab open until uploads finish. Safari may pause work when the phone locks.</p><div class="notice warn">Browser storage is not a permanent backup. Clearing website data can remove unexported photos. Private browsing is unsuitable for collection.</div><div class="actions"><button class="btn secondary" data-export="all">${icon("download")} Export all photos + labels</button><button class="btn secondary" id="csvExport">Labels CSV</button><button class="btn ghost" id="persistStorage">Request persistent storage</button></div><p id="storageStatus" class="tiny"></p><hr class="divider"><h3>Use it on your iPhone</h3><ol class="steps"><li>Open this site in <strong>Safari</strong> and sign in to access your private app.</li><li>Use Share → <strong>Add to Home Screen</strong> for quick access.</li><li>Allow camera access when prompted. Start with a pilot session.</li></ol><p class="tiny">This version requires the site to load online. If the connection drops while it is open, photos can stay locally queued. Reopen online and reconnect Drive to resume.</p><hr class="divider"><h3>What stays on your device?</h3><p class="tiny">Photos, measurements and setup notes are stored locally. Connecting Drive uploads approved photos and per-photo labels to your own account. This app uses no LLM API and does not train or run your prediction model.</p></section></div>`;
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
  extraShots = false;
  if (isV2(current)) {
    const keys = fillKeys(current),
      last = keys[keys.length - 1];
    if (last !== undefined && done(current, last) < countShots(current))
      level = last;
    else {
      level = nextFill(current);
      pendingTarget = null;
    }
    nav("shoot");
    return;
  }
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
  for (const b of $$("[data-newfill]"))
    b.onclick = () => {
      retake = null;
      retakeFill = null;
      extraShots = false;
      pendingTarget = null;
      level = nextFill(current);
      nav("shoot");
    };
  for (const b of $$("[data-fill]"))
    b.onclick = () => {
      retake = null;
      retakeFill = null;
      extraShots = false;
      level = Number(b.dataset.fill);
      nav("shoot");
    };
  on("#moreShots", "click", () => {
    extraShots = true;
    render();
  });
  on("#newTarget", "click", () => {
    pendingTarget = null;
    render();
  });
  on("#fileBatch", "click", () => {
    filePickerOpen = true;
  });
  on("#fileBatch", "cancel", () => {
    filePickerOpen = false;
  });
  on("#fileBatch", "change", async (e) => {
    filePickerOpen = false;
    const files = [...e.target.files];
    e.target.value = "";
    if (files.length) await prepareBatch(files);
  });
  for (const el of $$(
    "#sessionForm [name=bottle], #sessionForm [name=instance]",
  ))
    el.addEventListener("change", prefillSession);
  on("#sessionForm [name=session]", "input", (e) => {
    const s = $("#sessionForm [name=setup]");
    if (s && !s.dataset.touched) s.value = e.target.value;
  });
  on("#sessionForm [name=setup]", "input", (e) => {
    e.target.dataset.touched = "1";
  });
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
        background: String(f.get("background") || "").trim(),
        lighting: String(f.get("lighting") || "").trim(),
        tare: mass(f.get("tare")),
        reference: mass(f.get("reference")),
        resolution: mass(f.get("resolution")),
        created: new Date().toISOString(),
        fills: {},
        protocol: PROTOCOL,
      };
    await refresh();
    checkRun(r, runs);
    await put("runs", r);
    await refresh();
    current = r;
    nav("session");
    toast("Session created. Weigh your first fill.");
  });
  on("#massForm input[name=gross]", "input", (e) => {
    try {
      refillPending = null;
      farPending = null;
      $("#massPreview").className = "notice";
      $("#massSubmit").innerHTML = `Confirm & start photos ${icon("arrow")}`;
      const n = waterMass(current, level, mass(e.target.value)),
        warn = readingWarning(n);
      $("#massPreview").textContent = warn
        ? `Net water mass: ${grams(n)} g. ${warn}`
        : `Net water mass: ${grams(n)} g. This is the training label.`;
      if (warn) $("#massPreview").className = "notice warn";
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
    const warn = !f && readingWarning(n);
    if (warn && farPending !== gross) {
      farPending = gross;
      $("#massPreview").className = "notice warn";
      $("#massPreview").textContent =
        `Net water mass: ${grams(n)} g. ${warn} If the reading is right, tap the button again.`;
      $("#massSubmit").textContent = `Yes, use ${grams(n)} g water`;
      return;
    }
    farPending = null;
    if (f && Math.abs(gross - f.gross) > current.resolution) {
      if (!retake)
        throw Error(
          isV2(current)
            ? "This reading does not match the saved fill. If the water changed, go back and tap “Weigh a new fill”."
            : "This reading does not match the saved fill. Start a new session if the amount of water changed.",
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
        ...(isV2(current) && pendingTarget !== null
          ? { target: pendingTarget }
          : {}),
      };
      pendingTarget = null;
      await put("runs", current);
      // Keep the session list current, so Continue photos finds this fill.
      await refresh();
      current = runs.find((x) => x.id === current.id) || current;
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
    if (!$("#sameWaterOk").checked) return;
    if (!retake && !current.fills?.[level]) return;
    retakeFill = null;
    verified = true;
    render();
  });
  on("#correctFill", "click", openCorrect);
  on("#otherShot", "click", () => {
    const key = `${current.id}:${level}:${activeShot}`;
    shotSkip[key] = (shotSkip[key] || 0) + 1;
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
  $("#connectDrive")?.addEventListener("click", connectNow);
  $("#reconnectBadge")?.addEventListener("click", connectNow);
  on("#disconnectDrive", "click", async () => {
    drive.disconnect();
    await setting("driveWanted", false);
    await loadSettings();
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
  for (const b of $$("[data-uninvite]"))
    b.onclick = () => {
      const d = $("#modal"),
        who = b.dataset.who;
      d.innerHTML = `<h2>Remove ${esc(who)}?</h2><p>They lose access to the dataset folder and can no longer see, add, retake or delete photos. Photos they already uploaded stay in the folder.</p><div class="actions"><button class="btn danger" id="confirmUninvite">Remove access</button><button class="btn secondary" id="cancelUninvite">Cancel</button></div>`;
      d.showModal();
      $("#cancelUninvite").onclick = () => d.close();
      $("#confirmUninvite").onclick = async () => {
        $("#confirmUninvite").disabled = true;
        try {
          await drive.uninvite(b.dataset.uninvite);
          d.close();
          await loadSettings();
          render();
          toast(`${who} no longer has access to the dataset.`);
        } catch (e) {
          d.close();
          fail(e);
        }
      };
    };
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
      d.innerHTML = `<h2>${grams(p.mass)} g water</h2><img src="${objectURL(p.blob)}" style="width:100%;max-height:50vh;object-fit:contain" alt="${esc(p.name)}"><p class="filename">${esc(p.path)}</p><p>${esc(r.background)} · ${esc(r.lighting)}${p.spot ? `<br>${esc(p.spot)} · ${esc(p.facing || "")} · ${esc(p.camHeight || "")} · ${esc(p.distance || "")}` : ""}<br>Surface: ${esc(p.visibility)} · ${p.width} × ${p.height}</p><div class="actions">${r.archived ? "" : '<button class="btn" id="retakePhoto">Retake this photo</button>'}<button class="btn secondary" id="downloadPhoto">Download JPEG</button><button class="btn ghost" id="closeModal">Close</button></div>${r.archived ? '<p class="tiny">Archived attempts are read-only.</p>' : '<p class="tiny">Retake replaces this photo locally and on Google Drive after you save the new one. Until then, nothing is deleted.</p>'}`;
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
    `<section class="panel"><div class="eyebrow">Review before saving</div><h3>${grams(activeFill().mass)} g · ${isV2(current) ? `${fillLabel()} · photo ${activeShot + 1}` : `View ${shots[activeShot][0]}`}</h3>${Math.min(candidate.width, candidate.height) < 1000 ? '<div class="notice warn">Low image resolution. Consider retaking with iPhone Camera.</div>' : ""}<form id="reviewForm">${isV2(current) ? tagForm(shotPlan(current, level, activeShot), retakeTags()?.spot ?? shotPlan(current, level, activeShot).spot, false) : `<label class="field" style="margin-top:16px">Water surface visibility<select name="visibility" required><option value="">Choose after inspecting the photo</option><option value="visible">Visible</option><option value="partial">Partly visible</option><option value="hidden">Hidden behind label / bottle</option><option value="uncertain">Uncertain</option></select></label>`}<div class="actions"><button class="btn" type="submit" id="savePhoto">${retake ? "Save retake" : "Save & Next"} ${icon("arrow")}</button><button class="btn secondary" type="button" id="retake">Retake</button></div></form><p class="tiny">Saved locally first. ${drive.connected() ? (retake ? "Then the old Drive copy moves to Trash and the new photo uploads." : "Then automatically queued to Google Drive.") : "Connect Drive later or export this session to keep a backup."}</p></section>`;
  on("#reviewForm", "submit", savePhoto);
  $("#review").scrollIntoView({ behavior: "smooth", block: "start" });
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
    const tags = isV2(current)
        ? readTags(e.target)
        : { visibility: new FormData(e.target).get("visibility") },
      visibility = tags.visibility;
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
        ...(isV2(current) ? { target: f.target, ...tags } : { visibility }),
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
// Fix the weight of the current fill, for example when the empty bottle weight was
// entered by mistake. All photos of the fill get the new label, also on Drive.
function openCorrect() {
  const r = current,
    f = r.fills?.[level],
    n = done(r, level),
    name = `F${String(level).padStart(2, "0")}`,
    d = $("#modal");
  if (!f) return;
  d.innerHTML = `<h2>Correct the weight of ${name}</h2><p>Saved now: <strong>${grams(f.mass)} g water</strong> (${grams(f.gross)} g on the balance, empty bottle ${grams(r.tare)} g).</p><div class="notice warn">Only do this if the water in the bottle is still exactly what is in ${n ? `these ${n} photos` : "this fill"}. If you already poured water in or out, the true weight is lost: delete those photos instead.</div><form id="correctForm">${field("Filled bottle + cap (g)", "gross", "", "Put the bottle with its cap on the balance and enter the reading.", "decimal")}<div id="correctPreview" class="notice">The new water mass will appear here.</div><div class="actions"><button class="btn" type="submit" id="saveCorrect">Save new weight</button><button class="btn secondary" type="button" id="cancelCorrect">Cancel</button></div></form>${n ? `<p class="tiny">${n} photos get the new label here and on Google Drive at the next sync.</p>` : ""}`;
  d.showModal();
  $("#cancelCorrect").onclick = () => d.close();
  const input = d.querySelector("[name=gross]");
  input.oninput = () => {
    try {
      $("#correctPreview").textContent =
        `New water mass: ${grams(waterMass(r, level, mass(input.value)))} g.`;
    } catch (e) {
      $("#correctPreview").textContent = e.message;
    }
  };
  $("#correctForm").onsubmit = async (e) => {
    e.preventDefault();
    const button = $("#saveCorrect");
    button.disabled = true;
    try {
      const gross = mass(input.value),
        water = waterMass(r, level, gross);
      const changed = await drive.exclusive(() =>
        correctFill(r.id, level, gross, water),
      );
      d.close();
      await refresh();
      current = runs.find((x) => x.id === r.id) || current;
      render();
      toast(
        `${name} is now ${grams(water)} g water${changed ? ` · ${changed} photos relabelled` : ""}.`,
      );
      if (changed && drive.connected() && navigator.onLine)
        syncNow().catch(fail);
    } catch (err) {
      button.disabled = false;
      fail(err);
    }
  };
}
// Sign in with one tap. Must run straight from the tap, so Safari allows the sign-in window.
function connectNow() {
  drive
    .connect(settingsCache.client, settingsCache.email)
    .then(async (u) => {
      await setting("driveWanted", true);
      await loadSettings();
      render();
      toast("Connected as " + u.emailAddress + ". Loading your Drive dataset…");
      await pullNow();
      if (photos.some((p) => !p.synced)) await syncNow();
    })
    .catch(fail);
}
// Renew the login quietly when it has expired or is about to, for someone who stays connected.
// Where the browser does not allow that, the Reconnect badge stays and one tap fixes it.
let renewing = false;
async function keepConnected() {
  if (renewing || !navigator.onLine || !driveWanted()) return false;
  if (drive.connected() && drive.msLeft() > 5 * 60 * 1000) return true;
  renewing = true;
  try {
    // The Google sign-in script loads late. Give it a few seconds.
    for (let i = 0; i < 25 && !globalThis.google?.accounts?.oauth2; i++)
      await new Promise((r) => setTimeout(r, 200));
    await drive.renew(settingsCache.client, settingsCache.email);
    await loadSettings();
    if (!["shoot", "new"].includes(page) && !$("#modal").open) render();
    if (photos.some((p) => !p.synced)) syncNow().catch(() => {});
    return true;
  } catch {
    // Still shows the Reconnect badge.
    if (!["shoot", "new"].includes(page) && !$("#modal").open) render();
    return drive.connected();
  } finally {
    renewing = false;
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
    wanted: await setting("driveWanted"),
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
      batch = null;
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
  if (candidate || batch) {
    e.preventDefault();
    e.returnValue = "";
  }
});
await refresh();
await loadSettings();
await drive.restore(settingsCache.client);
// Someone who connected before earlier versions saved this flag: treat them as staying connected.
if (settingsCache.wanted === undefined && settingsCache.email) {
  await setting("driveWanted", true);
  settingsCache.wanted = true;
}
render();
// Bring in changes from other devices: on open, every 2 minutes, and when you return to the tab.
// Skipped while capturing or with a dialog open, so the screen never changes under you.
async function autoPull() {
  await keepConnected();
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
