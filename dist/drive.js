import {
  setting,
  get,
  put,
  all,
  remove,
  trashQueue,
  unqueueTrash,
  queueTrashIds,
} from "./db.js";
import { labelFor, fillFolder } from "./core.js";
let token = "",
  expires = 0,
  busy = false;
export const connected = () => !!token && Date.now() < expires;
export const isBusy = () => busy;
let retryWait = 3000;
export const setRetryWait = (ms) => (retryWait = ms); // tests only
// iPhone Safari freezes network requests as soon as the page goes to the background
// (phone camera, lock screen, app switch). A request that started before that usually
// never finishes, so it is dropped when the page comes back and the upload retries.
const live = new Set();
let hiddenAt = 0;
if (typeof document !== "undefined")
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) hiddenAt = Date.now();
    else
      for (const r of live)
        if (r.started < hiddenAt)
          r.ctl.abort(new DOMException("Paused by the phone", "AbortError"));
  });
// Network hiccups, timeouts, Google rate limits and server errors are worth retrying.
export const transient = (e) =>
  e?.name === "TypeError" ||
  e?.name === "AbortError" ||
  e?.name === "TimeoutError" ||
  e?.status === 429 ||
  e?.status >= 500;
// Full Drive access lets two Google accounts work in one shared dataset folder.
// (drive.file only sees files this account created, so a friend's uploads were invisible.)
export const SCOPE = "https://www.googleapis.com/auth/drive";
const ROOT_NAME = "BottleCapture Dataset";
// Delete marker. In a shared My Drive folder only a file's owner can trash it, so any
// collaborator marks a file or folder as deleted, and the owner's device trashes it later.
const DELETED = "bottlecaptureDeleted";
const sessionKey = "bottlecapture-drive-session";
// The login is kept in localStorage, so it survives closing the tab or the browser
// until it expires (Google logins last about 1 hour) or you tap Disconnect.
const stores = () =>
  [globalThis.localStorage, globalThis.sessionStorage].filter(Boolean);
function clearSession() {
  token = "";
  expires = 0;
  for (const st of stores()) {
    try {
      st.removeItem(sessionKey);
    } catch {}
  }
}
function saveSession(clientId) {
  const value = JSON.stringify({ token, expires, clientId, scope: SCOPE });
  let saved = false;
  for (const st of stores()) {
    try {
      if (!saved) {
        st.setItem(sessionKey, value);
        saved = true;
      } else st.removeItem(sessionKey);
    } catch {}
  }
}
// Milliseconds until the current login expires (0 when there is none).
export const msLeft = () => (token ? Math.max(0, expires - Date.now()) : 0);
export async function restore(clientId) {
  for (const st of stores()) {
    try {
      const saved = JSON.parse(st.getItem(sessionKey) || "null");
      if (
        saved &&
        saved.clientId === clientId &&
        saved.scope === SCOPE &&
        typeof saved.token === "string" &&
        Number.isFinite(saved.expires) &&
        saved.expires > Date.now()
      ) {
        token = saved.token;
        expires = saved.expires;
        return true;
      }
    } catch {}
  }
  clearSession();
  return false;
}
export function disconnect() {
  if (token && globalThis.google)
    google.accounts.oauth2.revoke(token, () => {});
  clearSession();
}
// Accept a token from Google: check the scope and the account, then remember it.
async function adopt(clientId, r) {
  if (r.error) throw Error(r.error_description || r.error);
  if (
    globalThis.google?.accounts?.oauth2?.hasGrantedAllScopes?.(r, SCOPE) ===
      false ||
    (r.scope && !String(r.scope).split(" ").includes(SCOPE))
  )
    throw Error(
      "Google Drive access was not allowed. Connect again and tick the Drive access box, so the shared dataset folder can be used.",
    );
  token = r.access_token;
  expires = Date.now() + (Number(r.expires_in) - 60) * 1000;
  try {
    const about = await api(
      "/about?fields=user(displayName,emailAddress,permissionId)",
    );
    const owner = await setting("driveOwner");
    if (owner && owner !== about.user.permissionId)
      throw Error(
        "Connect the same Google account used for this dataset. Account switching is disabled to prevent mixed uploads.",
      );
    await setting("driveOwner", about.user.permissionId);
    await setting("driveEmail", about.user.emailAddress);
    saveSession(clientId);
    return about.user;
  } catch (e) {
    clearSession();
    throw e;
  }
}
function requestToken(clientId, { prompt, hint }) {
  return new Promise((resolve, reject) => {
    const c = google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: SCOPE,
      ...(hint ? { hint } : {}),
      callback: resolve,
      error_callback: (e) =>
        reject(
          Error(
            e.type === "popup_closed"
              ? "Sign-in was closed."
              : "Could not open Google sign-in. Use Safari and allow the sign-in window.",
          ),
        ),
    });
    c.requestAccessToken({ prompt });
  });
}
// Sign in without a pop-up: go to Google's page and come straight back. Used on
// iPhone, where Chrome opens the sign-in pop-up as a separate tab and the reply
// often never reaches the app. Photos stay saved on the phone meanwhile.
// Needs this address as an "Authorized redirect URI" of the OAuth client.
const REDIRECT_KEY = "bc-oauth-redirect";
export const redirectUri = () =>
  location.origin + location.pathname.replace(/[^/]*$/, "");
export function connectByRedirect(clientId, hint) {
  if (!clientId?.endsWith(".apps.googleusercontent.com"))
    throw Error("Add your Google OAuth client ID in Settings first.");
  const state = crypto.randomUUID();
  sessionStorage.setItem(REDIRECT_KEY, JSON.stringify({ state, clientId }));
  const q = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri(),
    response_type: "token",
    scope: SCOPE,
    include_granted_scopes: "true",
    state,
    ...(hint ? { login_hint: hint } : { prompt: "select_account" }),
  });
  location.assign("https://accounts.google.com/o/oauth2/v2/auth?" + q);
}
// After coming back from Google: take the login from the address, then remove it.
export async function finishRedirect() {
  const h = new URLSearchParams(location.hash.slice(1));
  if (!h.has("access_token") && !h.has("error")) return null;
  let saved = null;
  try {
    saved = JSON.parse(sessionStorage.getItem(REDIRECT_KEY) || "null");
  } catch {}
  sessionStorage.removeItem(REDIRECT_KEY);
  history.replaceState(null, "", location.pathname + location.search);
  if (!saved || h.get("state") !== saved.state)
    throw Error("The Google sign-in reply did not match. Tap Reconnect again.");
  if (h.get("error"))
    throw Error(
      h.get("error") === "access_denied"
        ? "Google Drive access was not allowed."
        : "Google sign-in failed: " + h.get("error"),
    );
  return adopt(saved.clientId, {
    access_token: h.get("access_token"),
    expires_in: h.get("expires_in"),
    scope: h.get("scope"),
  });
}
// Call straight from a tap (no await before it), so Safari allows the sign-in window.
// With a known account (hint) Google skips the account chooser: one tap.
export async function connect(clientId, hint) {
  if (!clientId?.endsWith(".apps.googleusercontent.com"))
    throw Error("Add your Google OAuth client ID in Settings first.");
  if (!globalThis.google?.accounts?.oauth2)
    throw Error(
      "Google sign-in has not loaded. Check your connection and reopen the app in Safari.",
    );
  const r = await requestToken(clientId, {
    prompt: hint ? "" : "select_account",
    hint,
  });
  return adopt(clientId, r);
}
// Ask Google for a fresh login without showing anything, for an account that already
// approved this app. It works only while the Google sign-in in this browser is still
// active and the browser allows it. Otherwise it fails quietly and the Reconnect
// button is shown instead.
export async function renew(clientId, hint) {
  if (!clientId || !globalThis.google?.accounts?.oauth2)
    throw Error("Google sign-in has not loaded.");
  let timer;
  try {
    const r = await Promise.race([
      requestToken(clientId, { prompt: "none", hint }),
      new Promise(
        (_, rej) =>
          (timer = setTimeout(
            () => rej(Error("Silent sign-in timed out.")),
            10000,
          )),
      ),
    ]);
    return await adopt(clientId, r);
  } finally {
    clearTimeout(timer);
  }
}
// Safari says "Load failed", Chrome "Failed to fetch": the connection dropped.
const dropped = () =>
  Object.assign(
    Error(
      "The connection to Google Drive dropped for a moment. Your photos are safe on this phone and upload again automatically.",
    ),
    { name: "TypeError" },
  );
// Requests that are safe to send twice: reads, trash/rename (PATCH) and creates
// with a pre-generated file ID (Drive answers 409 to a repeat). Each gets two
// more tries after a network drop, a timeout, a rate limit or a server error.
async function api(path, options = {}) {
  const method = options.method || "GET",
    retry = options.retry ?? (method === "GET" || method === "PATCH");
  for (let attempt = 1; ; attempt++) {
    try {
      return await apiOnce(path, options);
    } catch (e) {
      const network = e?.name === "TypeError";
      if (retry && transient(e) && attempt < 3 && connected()) {
        await new Promise((ok) => setTimeout(ok, attempt * retryWait));
        continue;
      }
      throw network ? dropped() : e;
    }
  }
}
// One authorised request with a time limit. Requests that started before the
// page went to the background are dropped when it comes back (see above).
async function send(url, opts = {}, timeout = 90000) {
  if (!connected())
    throw Error("Reconnect Google Drive to continue uploading.");
  const req = { started: Date.now(), ctl: new AbortController() },
    timer = setTimeout(
      () =>
        req.ctl.abort(
          new DOMException("Drive did not answer in time", "TimeoutError"),
        ),
      timeout,
    );
  live.add(req);
  try {
    const r = await fetch(url, {
      ...opts,
      headers: { Authorization: "Bearer " + token, ...opts.headers },
      signal: req.ctl.signal,
    });
    if (r.status === 401) {
      clearSession();
      throw Error("Google session expired. Reconnect to continue.");
    }
    return r;
  } catch (e) {
    const why = req.ctl.signal.reason;
    throw why instanceof DOMException ? why : e;
  } finally {
    clearTimeout(timer);
    live.delete(req);
  }
}
async function failed(r) {
  const e = await r.json().catch(() => ({})),
    error = Error(e.error?.message || "Google Drive returned " + r.status);
  error.status = r.status;
  return error;
}
async function apiOnce(path, options = {}) {
  const { upload, raw, retry, timeout, ...opts } = options;
  const r = await send(
    (upload
      ? "https://www.googleapis.com/upload/drive/v3"
      : "https://www.googleapis.com/drive/v3") + path,
    opts,
    timeout,
  );
  if (!r.ok) throw await failed(r);
  if (raw) return r.blob();
  return r.status === 204 ? {} : r.json();
}
const FOLDER = "application/vnd.google-apps.folder";
const quote = (s) =>
  "'" + String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'") + "'";
// List every file matching a Drive query, across all result pages.
async function list(q, fields) {
  const out = [];
  let page = "";
  do {
    const r = await api(
      "/files?spaces=drive&pageSize=1000&q=" +
        encodeURIComponent(q) +
        "&fields=" +
        encodeURIComponent("nextPageToken,files(" + fields + ")") +
        (page ? "&pageToken=" + encodeURIComponent(page) : ""),
    );
    out.push(...(r.files || []));
    page = r.nextPageToken;
  } while (page);
  return out;
}
// Find a dataset folder another device already created, so this device reuses it.
async function findFolder(name, parent) {
  const found = await list(
    `name = ${quote(name)} and mimeType = '${FOLDER}' and ${quote(parent || "root")} in parents and trashed = false`,
    "id,createdTime",
  );
  found.sort((a, b) =>
    (a.createdTime || "").localeCompare(b.createdTime || ""),
  );
  return found[0]?.id;
}
async function nextId() {
  return (await api("/files/generateIds?count=1&space=drive&type=files"))
    .ids[0];
}
// Photos go up in 512 KB pieces (Google's resumable upload). Each piece has its
// own time limit, and after a dropped connection the upload continues from the
// last piece Drive confirmed, instead of starting the whole photo again. On a
// slow phone connection a 6 MB photo in one request could never finish.
// Pieces must be multiples of 256 KB. They start at 1 MB, double (up to 8 MB)
// while pieces go through quickly, and halve (down to 256 KB) after a failure.
const UNIT = 256 * 1024,
  PIECE_MIN = UNIT,
  PIECE_MAX = 32 * UNIT,
  PIECE = 4 * UNIT,
  RESUMABLE_FROM = 768 * 1024,
  uploads = new Map(); // file ID -> { url, size }, kept until the photo is done
// "single": this device uploads each photo in one request (chosen by the speed test).
let noResumable = (() => {
  try {
    return localStorage.getItem("bc-upload-mode") === "single";
  } catch {
    return false;
  }
})();
export const uploadMode = () => (noResumable ? "single" : "pieces");
export function setUploadMode(mode) {
  noResumable = mode === "single";
  try {
    localStorage.setItem("bc-upload-mode", mode);
  } catch {}
}
const FILE_FIELDS = "id,name,size,trashed,appProperties";
// How far Drive has got: returns the next byte to send, or the finished file.
async function uploadedSoFar(u) {
  const r = await send(
    u.url,
    { method: "PUT", headers: { "Content-Range": `bytes */${u.size}` } },
    30000,
  );
  if (r.ok) return { done: await r.json() };
  if (r.status === 308) {
    const m = (r.headers.get("Range") || "").match(/bytes=0-(\d+)/);
    return { next: m ? Number(m[1]) + 1 : 0 };
  }
  throw await failed(r);
}
let piece = PIECE;
export const pieceSize = () => piece;
async function resumable(id, meta, stored, onProgress) {
  // Read the photo into memory once. iPhone browsers can be slow at reading
  // slices of a photo that lives in the browser's storage.
  const blob = new Blob([await stored.arrayBuffer()], {
    type: stored.type || "application/octet-stream",
  });
  let u = uploads.get(id);
  if (!u || u.size !== blob.size) {
    const r = await send(
      `https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=${FILE_FIELDS}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=UTF-8",
          "X-Upload-Content-Type": blob.type || "application/octet-stream",
          "X-Upload-Content-Length": String(blob.size),
        },
        body: JSON.stringify({ id, ...meta }),
      },
      30000,
    );
    if (!r.ok) throw await failed(r);
    const url = r.headers.get("Location");
    if (!url) {
      // The browser could not read the upload address: use one request instead.
      noResumable = true;
      return null;
    }
    u = { url, size: blob.size };
    uploads.set(id, u);
  }
  let next = 0,
    misses = 0,
    speed = 0;
  try {
    const at = await uploadedSoFar(u);
    if (at.done) return at.done;
    next = at.next;
  } catch (e) {
    if (e.status === 404 || e.status === 410) uploads.delete(id); // expired: start over
    throw e;
  }
  while (true) {
    const end = Math.min(next + piece, blob.size),
      t0 = Date.now();
    onProgress?.(next / blob.size, speed);
    try {
      const r = await send(
        u.url,
        {
          method: "PUT",
          headers: { "Content-Range": `bytes ${next}-${end - 1}/${blob.size}` },
          body: blob.slice(next, end),
        },
        60000,
      );
      const took = Math.max(1, Date.now() - t0);
      speed = Math.round((end - next) / took); // KB/s (bytes per ms)
      if (r.ok) {
        uploads.delete(id);
        onProgress?.(1, speed);
        return r.json();
      }
      if (r.status === 308) {
        const m = (r.headers.get("Range") || "").match(/bytes=0-(\d+)/);
        next = m ? Number(m[1]) + 1 : end;
        misses = 0;
        if (took < 8000) piece = Math.min(piece * 2, PIECE_MAX);
        continue;
      }
      if (r.status === 404 || r.status === 410) uploads.delete(id);
      throw await failed(r);
    } catch (e) {
      // A dropped piece: wait, ask Drive what it already has, continue from there.
      piece = Math.max(PIECE_MIN, piece / 2);
      if (!transient(e) || ++misses > 6 || !connected()) throw e;
      await new Promise((ok) =>
        setTimeout(ok, Math.min(misses, 4) * retryWait),
      );
      const at = await uploadedSoFar(u).catch(() => null);
      if (at?.done) {
        uploads.delete(id);
        return at.done;
      }
      if (at) next = at.next;
    }
  }
}
async function ensureFile(id, meta, blob, onProgress) {
  try {
    return await api(
      "/files/" + id + "?fields=id,name,size,trashed,appProperties",
    );
  } catch (e) {
    if (e.status !== 404) throw e;
  }
  try {
    if (!blob)
      return await api("/files?fields=id,name", {
        retry: true,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, ...meta }),
      });
    if (blob.size >= RESUMABLE_FROM && !noResumable) {
      const done = await resumable(id, meta, blob, onProgress);
      if (done) return done;
    }
    const boundary = "bottle_" + crypto.randomUUID(),
      body = new Blob([
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ id, ...meta })}\r\n--${boundary}\r\nContent-Type: ${blob.type || "application/octet-stream"}\r\n\r\n`,
        blob,
        `\r\n--${boundary}--`,
      ]);
    return await api(
      "/files?uploadType=multipart&fields=id,name,size,trashed,appProperties",
      {
        upload: true,
        retry: true,
        timeout: Math.max(90000, (body.size / 15000) * 1000),
        method: "POST",
        headers: { "Content-Type": "multipart/related; boundary=" + boundary },
        body,
      },
    );
  } catch (e) {
    if (e.status === 409)
      return api("/files/" + id + "?fields=id,name,size,trashed,appProperties");
    throw e;
  }
}
// Which "BottleCapture Dataset" folder to use, in order:
// 1. a folder link pasted in Settings, 2. a folder someone shared with this account,
// 3. this account's own folder.
// Which "BottleCapture Dataset" folder is the shared one: a folder link pasted in
// Settings, otherwise the OLDEST dataset folder this account can see (its own or one
// shared with it). The person who started the project created theirs first, so every
// collaborator converges on that one, even if they connected before it was shared.
export async function findRoot() {
  const picked = await setting("datasetRoot");
  if (picked) return picked;
  const q = `name = ${quote(ROOT_NAME)} and mimeType = '${FOLDER}' and trashed = false`;
  const found = [
    ...(await list(q + " and sharedWithMe = true", "id,createdTime")),
    ...(await list(q + " and 'root' in parents", "id,createdTime")),
  ];
  found.sort((a, b) =>
    (a.createdTime || "").localeCompare(b.createdTime || ""),
  );
  return found[0]?.id;
}
// Make sure this device uses the shared dataset folder. If it has been using another
// one (for example its own, created before the shared folder was shared), switch,
// and queue this device's photos to upload again into the shared folder. The old
// copies are then removed from the old folder.
async function resolveRoot(onStatus) {
  let current = await setting("folder:root");
  if (current) {
    const f = await api("/files/" + current + "?fields=id,trashed").catch(
      (e) => {
        if (e.status === 404) return null;
        throw e;
      },
    );
    if (!f || f.trashed) current = null;
  }
  const best = await findRoot();
  if (!best || best === current) return current || best || null;
  if (current) {
    onStatus("Switching to the shared dataset folder…");
    const moved = [];
    for (const p of await all("photos"))
      if (p.cloud) {
        moved.push(p.cloud.image, p.cloud.label);
        const { cloud, syncedAt, ...rest } = p;
        await put("photos", { ...rest, synced: false });
      }
    await queueTrashIds(moved);
  }
  for (const x of await all("settings"))
    if (x.id.startsWith("folder:")) await remove("settings", x.id);
  await setting("folder:root", best);
  await setting("driveRoot", best);
  return best;
}
// People who can open the dataset folder.
export async function collaborators() {
  const id = await setting("folder:root");
  if (!id || !connected()) return [];
  const r = await api(
    "/files/" +
      id +
      "/permissions?fields=" +
      encodeURIComponent("permissions(id,type,role,emailAddress,displayName)"),
  ).catch(() => ({ permissions: [] }));
  return (r.permissions || []).filter((x) => x.type === "user");
}
// Share the dataset folder with a partner as Editor. Google emails them a link.
export async function invite(email) {
  const id = await setting("folder:root");
  if (!id)
    throw Error("Sync once first, so the dataset folder exists on Drive.");
  return api(
    "/files/" + id + "/permissions?sendNotificationEmail=true&fields=id",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "user",
        role: "writer",
        emailAddress: email,
      }),
    },
  );
}
// Take away someone's access to the dataset folder (owner only).
export async function uninvite(permissionId) {
  const id = await setting("folder:root");
  return api(
    "/files/" + id + "/permissions/" + encodeURIComponent(permissionId),
    {
      method: "DELETE",
    },
  );
}
export async function rootInfo() {
  const id = await setting("folder:root");
  if (!id || !connected()) return null;
  try {
    return await api(
      "/files/" +
        id +
        "?fields=id,name,ownedByMe,owners(emailAddress),capabilities(canAddChildren,canShare)",
    );
  } catch {
    return null;
  }
}
async function folder(key, name, parent) {
  let id = await setting("folder:" + key);
  if (!id) {
    id =
      (key === "root" ? await findRoot() : await findFolder(name, parent)) ||
      (await nextId());
    await setting("folder:" + key, id);
  }
  const f = await ensureFile(id, {
    name,
    mimeType: "application/vnd.google-apps.folder",
    ...(parent ? { parents: [parent] } : {}),
  });
  if (f.trashed)
    throw Error(
      "A dataset folder is in Google Drive Trash. Restore it before syncing.",
    );
  if (f.appProperties?.[DELETED]) {
    const e = Error(`“${name}” was deleted on another device.`);
    e.code = "deleted";
    throw e;
  }
  return id;
}
// One queue for every Drive-changing job in this tab, plus Web Locks across tabs.
let chain = Promise.resolve();
export function exclusive(fn) {
  const run = () =>
    navigator.locks ? navigator.locks.request("bottlecapture-drive", fn) : fn();
  const result = chain.then(run, run);
  chain = result.catch(() => {});
  return result;
}
// Remove queued Drive items (deleted sessions, replaced photos) for everyone.
// Each item is marked deleted first, which works for any collaborator. Files this
// account owns then go straight to Trash (recoverable for 30 days). Folders are
// trashed later by their owner, once nobody else's files are inside.
export async function emptyTrash(onStatus = () => {}) {
  const ids = await trashQueue();
  for (let i = 0; i < ids.length; i++) {
    onStatus(`Removing old Drive files ${i + 1} of ${ids.length}`);
    try {
      const f = await api(
        "/files/" + ids[i] + "?fields=id,mimeType,ownedByMe,trashed",
      );
      if (!f.trashed) {
        await api("/files/" + ids[i] + "?fields=id", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            appProperties: { [DELETED]: new Date().toISOString() },
          }),
        });
        if (f.ownedByMe && f.mimeType !== FOLDER)
          await api("/files/" + ids[i] + "?fields=id", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ trashed: true }),
          });
      }
    } catch (e) {
      // 404: already gone. 403: no edit access to this item; nothing more this device can do.
      if (e.status !== 404 && e.status !== 403) throw e;
    }
    await unqueueTrash(ids[i]);
  }
  return ids.length;
}
export const pendingTrash = async () => (await trashQueue()).length;

// Load sessions and photos that other devices uploaded to the same Drive dataset.
// Also mirrors changes made elsewhere: retaken photos are replaced, and photos whose
// Drive files were deleted (moved to Trash) are removed here. Photos that this
// device has not uploaded yet are never touched.
// Children of many folders, in chunks so the query stays short.
async function childrenOf(parents, extra, fields) {
  const out = [];
  for (let i = 0; i < parents.length; i += 25) {
    const ps = parents
      .slice(i, i + 25)
      .map((p) => `${quote(p)} in parents`)
      .join(" or ");
    out.push(
      ...(await list(`(${ps}) and ${extra} and trashed = false`, fields)),
    );
  }
  return out;
}
export async function pull(onStatus = () => {}) {
  return exclusive(async () => {
    if (!connected()) throw Error("Connect Google Drive to load your dataset.");
    onStatus("Checking Google Drive for changes…");
    const root = await resolveRoot(onStatus);
    const result = { added: 0, replaced: 0, removed: 0, skipped: 0 };
    if (!root) {
      onStatus("No BottleCapture Dataset folder on this Google Drive yet.");
      return result;
    }
    await setting("folder:root", root);
    await setting("driveRoot", root);
    const fields =
      "id,name,parents,size,createdTime,ownedByMe,appProperties,owners(emailAddress)";
    // Walk only the dataset tree: root → bottle → instance → session → level.
    const folders = new Map();
    let layer = [root];
    for (let depth = 0; depth < 4 && layer.length; depth++) {
      const found = await childrenOf(layer, `mimeType = '${FOLDER}'`, fields);
      for (const f of found) folders.set(f.id, f);
      layer = found.map((f) => f.id);
    }
    const levelIds = layer;
    const marked = (f) => !!f?.appProperties?.[DELETED];
    // A folder and its parents up to (not including) the root.
    const lineage = (id) => {
      const out = [];
      for (
        let f = folders.get(id);
        f && out.length < 4;
        f = folders.get(f.parents?.[0])
      )
        out.push(f);
      return out;
    };
    // [level, session, instance, bottle] for a level folder in this dataset.
    const chain = (id) => {
      const out = lineage(id);
      return out.length === 4 && out[3].parents?.includes(root) ? out : null;
    };
    const files = [
      ...(await childrenOf(levelIds, "mimeType = 'application/json'", fields)),
      ...(await childrenOf(levelIds, "mimeType = 'image/jpeg'", fields)),
    ].filter((f) => chain(f.parents?.[0]));
    const gone = (f) => marked(f) || chain(f.parents[0]).some(marked);
    // One photo slot = one filename in one level folder. If two people saved the
    // same slot (for example both retook it), the newest upload wins.
    const newest = (list) => {
      const m = new Map();
      for (const f of list) {
        const k = f.parents[0] + "/" + f.name,
          o = m.get(k);
        if (!o || (f.createdTime || "") > (o.createdTime || "")) m.set(k, f);
      }
      return m;
    };
    const labels = [
        ...newest(
          files.filter((f) => f.name.endsWith(".json") && !gone(f)),
        ).values(),
      ],
      images = newest(files.filter((f) => f.name.endsWith(".jpg") && !gone(f))),
      inWalk = new Map(files.map((f) => [f.id, f])),
      liveLabels = new Set(labels.map((f) => f.id));
    const local = await all("photos"),
      known = new Set(local.map((p) => p.cloud?.label).filter(Boolean)),
      fresh = labels.filter((f) => !known.has(f.id));
    for (let i = 0; i < fresh.length; i++) {
      const f = fresh[i],
        img = images.get(
          f.parents[0] + "/" + f.name.replace(/\.json$/, ".jpg"),
        );
      if (!img) {
        result.skipped++;
        continue;
      }
      onStatus(`Loading from Drive ${i + 1} of ${fresh.length} · ${img.name}`);
      const label = JSON.parse(
          await (
            await api("/files/" + f.id + "?alt=media", { raw: true })
          ).text(),
        ),
        [runId, lv, sh] = String(label.photo_id || "").split(":"),
        level = Number(lv),
        shot = Number(sh);
      if (!runId || !Number.isInteger(level) || !Number.isInteger(shot)) {
        result.skipped++;
        continue;
      }
      const existing = await get("photos", label.photo_id);
      if (existing && !existing.synced) {
        // This device has its own unsent photo for the same slot. Keep it; it uploads next.
        result.skipped++;
        continue;
      }
      const blob = await api("/files/" + img.id + "?alt=media", { raw: true });
      if (blob.size !== Number(img.size)) {
        result.skipped++;
        continue;
      }
      const [lvlF, sessF, instF, botF] = chain(f.parents[0]);
      let r = await get("runs", runId);
      if (!r)
        r = {
          id: runId,
          bottle: label.bottle_id,
          instance: label.instance_id,
          session: String(label.session_id).replace(/_[^_]*$/, ""),
          setup: label.setup_id,
          split: label.split,
          background: label.background,
          lighting: label.lighting,
          tare: label.tare_g,
          reference: label.reference_water_g,
          resolution: label.scale_resolution_g,
          created: label.taken_at,
          fills: {},
          importedFromDrive: new Date().toISOString(),
          ...(Number(label.protocol) > 1
            ? { protocol: Number(label.protocol) }
            : {}),
        };
      r.uploadedBy ||= sessF.owners?.[0]?.emailAddress;
      if (label.taken_at && label.taken_at < r.created)
        r.created = label.taken_at;
      // A fill weight corrected on another device: take the corrected reading.
      if (
        r.fills[level] &&
        label.fill_gross_mass_g !== undefined &&
        label.fill_gross_mass_g !== r.fills[level].gross
      )
        r.fills[level] = {
          ...r.fills[level],
          gross: label.fill_gross_mass_g,
          mass: label.fill_water_mass_g,
        };
      if (!r.fills[level])
        r.fills[level] = {
          gross: label.gross_mass_g,
          mass: label.water_mass_g,
          measuredAt: label.taken_at,
          ...(Number(label.protocol) > 1
            ? { target: label.target_water_g }
            : {}),
        };
      await put("runs", r);
      for (const [key, id] of [
        [r.bottle, botF.id],
        [r.bottle + "/" + r.instance, instF.id],
        [r.id, sessF.id],
        [r.id + "/" + level, lvlF.id],
      ])
        if (!(await setting("folder:" + key)))
          await setting("folder:" + key, id);
      await put("photos", {
        id: label.photo_id,
        run: runId,
        level,
        shot,
        name: img.name,
        path: label.relative_path,
        mass: label.water_mass_g,
        gross: label.gross_mass_g,
        visibility: label.visibility,
        ...(label.spot ? { spot: label.spot } : {}),
        ...(label.label_facing ? { facing: label.label_facing } : {}),
        ...(label.camera_height ? { camHeight: label.camera_height } : {}),
        ...(label.distance ? { distance: label.distance } : {}),
        ...(Number(label.protocol) > 1 ? { target: label.target_water_g } : {}),
        blob: new Blob([blob], { type: "image/jpeg" }),
        width: label.width,
        height: label.height,
        takenAt: label.taken_at,
        synced: true,
        syncedAt: new Date().toISOString(),
        cloud: { image: img.id, label: f.id },
        ...(existing ? { retakenAt: new Date().toISOString() } : {}),
      });
      existing ? result.replaced++ : result.added++;
    }
    // Deleted on another device. Unsent photos are never touched.
    for (const p of await all("photos")) {
      if (!p.synced || !p.cloud?.label || liveLabels.has(p.cloud.label))
        continue;
      const seen = inWalk.get(p.cloud.label);
      if (seen) {
        if (!gone(seen)) continue;
      } else {
        // Not in this dataset folder: remove only if Drive confirms it is gone.
        const f = await api(
          "/files/" + p.cloud.label + "?fields=id,trashed,appProperties",
        ).catch((e) => {
          if (e.status === 404) return null;
          throw e;
        });
        if (f && !f.trashed && !marked(f)) continue;
      }
      await remove("photos", p.id);
      result.removed++;
    }
    // Sessions deleted elsewhere disappear here, unless this device has unsent photos in them.
    const left = await all("photos");
    for (const r of await all("runs")) {
      const sessId = await setting("folder:" + r.id),
        sess = folders.get(sessId),
        mine = left.filter((p) => p.run === r.id);
      if (sess?.owners?.[0]?.emailAddress && !r.uploadedBy)
        await put("runs", { ...r, uploadedBy: sess.owners[0].emailAddress });
      const deleted = !!sess && lineage(sessId).some(marked);
      if (
        (deleted || (r.importedFromDrive && !mine.length)) &&
        mine.every((p) => p.synced)
      ) {
        for (const p of mine) await remove("photos", p.id);
        await remove("runs", r.id);
      }
    }
    // Owner clean-up: Trash items marked deleted, once nobody else's files are inside.
    const foreignInside = new Set();
    for (const f of [...files, ...folders.values()])
      if (!f.ownedByMe)
        for (
          let p = folders.get(f.parents?.[0]);
          p;
          p = folders.get(p.parents?.[0])
        )
          foreignInside.add(p.id);
    const toTrash = [
      ...files.filter((f) => f.ownedByMe && gone(f)),
      ...[...folders.values()].filter(
        (f) => f.ownedByMe && marked(f) && !foreignInside.has(f.id),
      ),
    ];
    for (const f of toTrash)
      await api("/files/" + f.id + "?fields=id", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trashed: true }),
      }).catch(() => {});
    onStatus(
      `Drive checked · ${result.added} new, ${result.replaced} updated, ${result.removed} removed` +
        (result.skipped
          ? `, ${result.skipped} waiting (upload in progress or unsent here)`
          : "") +
        ".",
    );
    return result;
  });
}
// Measure where upload time goes on this device. Uploads a 2 MB test file twice
// (in pieces and in one request) into the dataset folder, then moves both to
// Drive Trash. Also times reading one stored photo from this browser.
export async function speedTest(onStatus = () => {}) {
  if (busy) throw Error("An upload is running. Try again in a moment.");
  busy = true;
  try {
    return await exclusive(async () => {
      if (!connected()) throw Error("Connect Google Drive first.");
      const out = {},
        root = (await setting("driveRoot")) || (await findRoot());
      if (!root) throw Error("No dataset folder yet. Upload one photo first.");
      onStatus("Reading one stored photo…");
      const stored =
        (await all("photos")).find((p) => !p.synced) ||
        (await all("photos"))[0];
      if (stored) {
        const t = Date.now();
        await stored.blob.arrayBuffer();
        out.readMs = Date.now() - t;
        out.readMB = +(stored.blob.size / 1e6).toFixed(1);
      }
      const size = 2 * 1024 * 1024,
        bytes = new Uint8Array(size);
      crypto.getRandomValues(bytes.subarray(0, 65536));
      const blob = new Blob([bytes], { type: "application/octet-stream" }),
        meta = (n) => ({
          name: `_speedtest_${n}_${Date.now()}.bin`,
          parents: [root],
        });
      const made = [];
      try {
        onStatus("Uploading 2 MB in pieces…");
        let t = Date.now();
        const id1 = await nextId(),
          saved = piece;
        piece = PIECE;
        const a = await resumable(id1, meta("pieces"), blob);
        piece = saved;
        if (a) {
          made.push(id1);
          out.piecesKBs = Math.round(size / (Date.now() - t));
        } else out.piecesKBs = "not available in this browser";
        onStatus("Uploading 2 MB in one request…");
        t = Date.now();
        const id2 = await nextId(),
          boundary = "bottle_" + crypto.randomUUID(),
          body = new Blob([
            `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ id: id2, ...meta("single") })}\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`,
            blob,
            `\r\n--${boundary}--`,
          ]);
        await api("/files?uploadType=multipart&fields=id", {
          upload: true,
          method: "POST",
          timeout: 300000,
          headers: {
            "Content-Type": "multipart/related; boundary=" + boundary,
          },
          body,
        });
        made.push(id2);
        out.singleKBs = Math.round(size / (Date.now() - t));
      } finally {
        for (const id of made)
          await api("/files/" + id, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ trashed: true }),
          }).catch(() => {});
      }
      return out;
    });
  } finally {
    busy = false;
  }
}
export async function sync(onStatus = () => {}) {
  if (busy) return;
  busy = true;
  const work = async () => {
    try {
      if (!connected())
        throw Error("Connect Google Drive to upload your saved photos.");
      await resolveRoot(onStatus);
      const removed = await emptyTrash(onStatus);
      const root = await folder("root", ROOT_NAME);
      await setting("driveRoot", root);
      const runs = await all("runs");
      let uploaded = 0,
        lastError = null;
      const blocked = new Set(),
        skipped = new Set(); // failed this round; tried again on the next sync
      while (true) {
        const pending = (await all("photos")).filter(
          (p) => !p.synced && !blocked.has(p.id) && !skipped.has(p.id),
        );
        if (!pending.length) break;
        for (let i = 0; i < pending.length; i++) {
          let p = await get("photos", pending[i].id);
          if (!p || p.synced) continue;
          const r = await get("runs", p.run);
          if (!r) continue;
          onStatus(`Uploading ${i + 1} of ${pending.length} · ${p.name}`);
          for (let attempt = 1; ; attempt++)
            try {
              const b = await folder(r.bottle, r.bottle, root),
                instance = await folder(
                  r.bottle + "/" + r.instance,
                  r.instance,
                  b,
                ),
                sess = await folder(
                  r.id,
                  r.session + "_" + r.id.slice(0, 8),
                  instance,
                ),
                level = await folder(
                  r.id + "/" + p.level,
                  fillFolder(r, p.level),
                  sess,
                );
              // A corrected label keeps its uploaded image and only gets a new JSON.
              if (!p.cloud?.image || !p.cloud?.label) {
                p.cloud = {
                  image: p.cloud?.image || (await nextId()),
                  label: p.cloud?.label || (await nextId()),
                };
                await put("photos", p);
              }
              const image = await ensureFile(
                p.cloud.image,
                { name: p.name, parents: [level], mimeType: "image/jpeg" },
                p.blob,
                (f, kbs) =>
                  onStatus(
                    `Uploading ${i + 1} of ${pending.length} · ${p.name} · ${Math.round(f * 100)}%${kbs ? ` · ${kbs} KB/s` : ""}`,
                  ),
              );
              if (image.trashed || Number(image.size) !== p.blob.size)
                throw Error(
                  "Cloud photo size differs or the photo is in Trash. Check Drive before continuing.",
                );
              const label = new Blob(
                [JSON.stringify(labelFor(p, r), null, 2)],
                {
                  type: "application/json",
                },
              );
              const record = await ensureFile(
                p.cloud.label,
                {
                  name: p.name.replace(".jpg", ".json"),
                  parents: [level],
                  mimeType: "application/json",
                },
                label,
              );
              if (record.trashed || Number(record.size) !== label.size)
                throw Error("Cloud measurement record needs checking.");
              uploaded++;
              p.synced = true;
              p.syncedAt = new Date().toISOString();
              await put("photos", p);
              onStatus(`Saved to Google Drive · ${p.name}`);
              break;
            } catch (e) {
              // A short wait and a second try fixes most mobile-network hiccups.
              if (transient(e) && attempt < 3 && connected()) {
                onStatus(`Connection hiccup, trying ${p.name} again…`);
                await new Promise((ok) => setTimeout(ok, attempt * retryWait));
                p = (await get("photos", p.id)) || p;
                if (p.synced) break;
                continue;
              }
              if (e.code === "deleted") {
                // Kept on this device, never removed automatically. Export or delete it here.
                blocked.add(p.id);
                break;
              }
              // Login gone or Drive refusing everything: stop. Otherwise skip this
              // photo for now so the rest of the queue keeps moving.
              if (!connected() || e.status === 403) throw e;
              skipped.add(p.id);
              lastError = e;
              onStatus(`${p.name} will be tried again later · ${e.message}`);
              break;
            }
        }
      }
      if (skipped.size) {
        const e = Error(
          `${skipped.size} photo${skipped.size > 1 ? "s" : ""} did not upload yet and will be tried again: ${lastError?.message || "connection problem"}`,
        );
        e.name = lastError?.name || "Error";
        e.status = lastError?.status;
        throw e;
      }
      onStatus(
        blocked.size
          ? `${blocked.size} photos were not uploaded: their session was deleted on another device. They stay on this device.`
          : uploaded
            ? "All queued photos and labels are saved to Google Drive."
            : removed
              ? "Old Drive files moved to Trash. No pending uploads."
              : "No pending uploads.",
      );
    } finally {
      busy = false;
    }
  };
  try {
    await exclusive(work);
  } catch (e) {
    busy = false;
    throw e;
  }
}
