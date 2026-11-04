import {
  setting,
  get,
  put,
  all,
  remove,
  trashQueue,
  unqueueTrash,
} from "./db.js";
import { labelFor } from "./core.js";
let token = "",
  expires = 0,
  busy = false;
export const connected = () => !!token && Date.now() < expires;
// Full Drive access lets two Google accounts work in one shared dataset folder.
// (drive.file only sees files this account created, so a friend's uploads were invisible.)
export const SCOPE = "https://www.googleapis.com/auth/drive";
const ROOT_NAME = "BottleCapture Dataset";
const sessionKey = "bottlecapture-drive-session";
function clearSession() {
  token = "";
  expires = 0;
  try {
    globalThis.sessionStorage?.removeItem(sessionKey);
  } catch {}
}
function saveSession(clientId) {
  try {
    globalThis.sessionStorage?.setItem(
      sessionKey,
      JSON.stringify({ token, expires, clientId, scope: SCOPE }),
    );
  } catch {}
}
export async function restore(clientId) {
  try {
    const saved = JSON.parse(
      globalThis.sessionStorage?.getItem(sessionKey) || "null",
    );
    if (
      !saved ||
      saved.clientId !== clientId ||
      saved.scope !== SCOPE ||
      typeof saved.token !== "string" ||
      !Number.isFinite(saved.expires) ||
      saved.expires <= Date.now()
    ) {
      clearSession();
      return false;
    }
    token = saved.token;
    expires = saved.expires;
    return true;
  } catch {
    clearSession();
    return false;
  }
}
export function disconnect() {
  if (token && globalThis.google)
    google.accounts.oauth2.revoke(token, () => {});
  clearSession();
}
export async function connect(clientId) {
  if (!clientId?.endsWith(".apps.googleusercontent.com"))
    throw Error("Add your Google OAuth client ID in Settings first.");
  if (!globalThis.google?.accounts?.oauth2)
    throw Error(
      "Google sign-in has not loaded. Check your connection and reopen the app in Safari.",
    );
  return new Promise((resolve, reject) => {
    const c = google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: SCOPE,
      callback: async (r) => {
        if (r.error) return reject(Error(r.error_description || r.error));
        if (google.accounts.oauth2.hasGrantedAllScopes?.(r, SCOPE) === false)
          return reject(
            Error(
              "Google Drive access was not allowed. Connect again and tick the Drive access box, so the shared dataset folder can be used.",
            ),
          );
        token = r.access_token;
        expires = Date.now() + (Number(r.expires_in) - 60) * 1000;
        try {
          const about = await api(
            "/about?fields=user(displayName,emailAddress,permissionId)",
          );
          const owner = await setting("driveOwner");
          if (owner && owner !== about.user.permissionId) {
            token = "";
            expires = 0;
            throw Error(
              "Connect the same Google account used for this dataset. Account switching is disabled to prevent mixed uploads.",
            );
          }
          await setting("driveOwner", about.user.permissionId);
          await setting("driveEmail", about.user.emailAddress);
          saveSession(clientId);
          resolve(about.user);
        } catch (e) {
          clearSession();
          reject(e);
        }
      },
      error_callback: (e) =>
        reject(
          Error(
            e.type === "popup_closed"
              ? "Sign-in was closed."
              : "Could not open Google sign-in. Use Safari and allow the sign-in window.",
          ),
        ),
    });
    c.requestAccessToken({ prompt: "select_account" });
  });
}
async function api(path, options = {}) {
  if (!connected())
    throw Error("Reconnect Google Drive to continue uploading.");
  const { upload, raw, ...opts } = options;
  const r = await fetch(
    (upload
      ? "https://www.googleapis.com/upload/drive/v3"
      : "https://www.googleapis.com/drive/v3") + path,
    {
      ...opts,
      headers: { Authorization: "Bearer " + token, ...opts.headers },
      signal: AbortSignal.timeout(90000),
    },
  );
  if (r.status === 401) {
    clearSession();
    throw Error("Google session expired. Reconnect to continue.");
  }
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    const error = Error(
      e.error?.message || "Google Drive returned " + r.status,
    );
    error.status = r.status;
    throw error;
  }
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
async function ensureFile(id, meta, blob) {
  try {
    return await api("/files/" + id + "?fields=id,name,size,trashed");
  } catch (e) {
    if (e.status !== 404) throw e;
  }
  try {
    if (!blob)
      return await api("/files?fields=id,name", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, ...meta }),
      });
    const boundary = "bottle_" + crypto.randomUUID(),
      body = new Blob([
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ id, ...meta })}\r\n--${boundary}\r\nContent-Type: ${blob.type || "application/octet-stream"}\r\n\r\n`,
        blob,
        `\r\n--${boundary}--`,
      ]);
    return await api(
      "/files?uploadType=multipart&fields=id,name,size,trashed",
      {
        upload: true,
        method: "POST",
        headers: { "Content-Type": "multipart/related; boundary=" + boundary },
        body,
      },
    );
  } catch (e) {
    if (e.status === 409)
      return api("/files/" + id + "?fields=id,name,size,trashed");
    throw e;
  }
}
// Which "BottleCapture Dataset" folder to use, in order:
// 1. a folder link pasted in Settings, 2. a folder someone shared with this account,
// 3. this account's own folder.
export async function findRoot() {
  const picked = await setting("datasetRoot");
  if (picked) return picked;
  const shared = await list(
    `name = ${quote(ROOT_NAME)} and mimeType = '${FOLDER}' and sharedWithMe = true and trashed = false`,
    "id,createdTime",
  );
  shared.sort((a, b) =>
    (a.createdTime || "").localeCompare(b.createdTime || ""),
  );
  return shared[0]?.id || (await findFolder(ROOT_NAME));
}
export async function rootInfo() {
  const id = await setting("folder:root");
  if (!id || !connected()) return null;
  try {
    return await api(
      "/files/" +
        id +
        "?fields=id,name,owners(emailAddress),capabilities(canAddChildren)",
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
// Move queued Drive files (deleted sessions, replaced photos) to Trash.
// Trash keeps them recoverable for 30 days. Missing files are already gone.
export async function emptyTrash(onStatus = () => {}) {
  const ids = await trashQueue();
  for (let i = 0; i < ids.length; i++) {
    onStatus(`Removing old Drive files ${i + 1} of ${ids.length}`);
    try {
      await api("/files/" + ids[i] + "?fields=id,trashed", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trashed: true }),
      });
    } catch (e) {
      // 404: already gone. 403: owned by someone else in the shared folder; only they can remove it.
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
    onStatus("Looking for your dataset on Google Drive…");
    let root = await setting("folder:root");
    if (root) {
      const f = await api("/files/" + root + "?fields=id,trashed").catch(
        (e) => {
          if (e.status === 404) return null;
          throw e;
        },
      );
      if (!f || f.trashed) root = null;
    }
    root = root || (await findRoot());
    const result = { added: 0, replaced: 0, removed: 0, skipped: 0 };
    if (!root) {
      onStatus("No BottleCapture Dataset folder on this Google Drive yet.");
      return result;
    }
    await setting("folder:root", root);
    await setting("driveRoot", root);
    // Walk only the dataset tree: root → bottle → instance → session → level.
    const folders = new Map(),
      isFolder = `mimeType = '${FOLDER}'`;
    let layer = [root];
    for (let depth = 0; depth < 4 && layer.length; depth++) {
      const found = await childrenOf(
        layer,
        isFolder,
        depth === 2
          ? "id,name,parents,owners(emailAddress)"
          : "id,name,parents",
      );
      for (const f of found) folders.set(f.id, f);
      layer = found.map((f) => f.id);
    }
    const levelIds = layer;
    // Returns [level, session, instance, bottle] folders when id is a level folder in this dataset.
    const chain = (id) => {
      const out = [];
      for (
        let f = folders.get(id);
        f && out.length < 4;
        f = folders.get(f.parents?.[0])
      )
        out.push(f);
      return out.length === 4 && out[3].parents?.includes(root) ? out : null;
    };
    const labels = (
      await childrenOf(
        levelIds,
        "mimeType = 'application/json'",
        "id,name,parents,size",
      )
    ).filter((f) => chain(f.parents?.[0]));
    const liveLabels = new Set(labels.map((f) => f.id));
    const images = new Map(
      (
        await childrenOf(
          levelIds,
          "mimeType = 'image/jpeg'",
          "id,name,parents,size",
        )
      ).map((f) => [f.parents?.[0] + "/" + f.name, f]),
    );
    // Who uploaded each session, so other people's sessions stay view-only here.
    for (const r of await all("runs")) {
      const sess = await setting("folder:" + r.id),
        by = folders.get(sess)?.owners?.[0]?.emailAddress;
      if (by && r.uploadedBy !== by)
        await put("runs", { ...r, uploadedBy: by });
    }
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
        // This device has its own unsent photo for the same slot. Keep it.
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
      if (r && !r.uploadedBy && sessF.owners?.[0]?.emailAddress)
        r.uploadedBy = sessF.owners[0].emailAddress;
      if (!r) {
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
          uploadedBy: sessF.owners?.[0]?.emailAddress,
        };
      }
      if (label.taken_at && label.taken_at < r.created)
        r.created = label.taken_at;
      if (!r.fills[level])
        r.fills[level] = {
          gross: label.gross_mass_g,
          mass: label.water_mass_g,
          measuredAt: label.taken_at,
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
        blob: new Blob([blob], { type: "image/jpeg" }),
        width: label.width,
        height: label.height,
        takenAt: label.taken_at,
        synced: true,
        syncedAt: new Date().toISOString(),
        cloud: { image: img.id, label: f.id },
      });
      existing ? result.replaced++ : result.added++;
    }
    // Deleted or retaken on another device: the old Drive record is gone or in Trash.
    for (const p of await all("photos"))
      if (p.synced && p.cloud?.label && !liveLabels.has(p.cloud.label)) {
        // Only remove when Drive confirms the file is gone or in Trash,
        // not just outside the folder this device is using now.
        const f = await api(
          "/files/" + p.cloud.label + "?fields=id,trashed",
        ).catch((e) => {
          if (e.status === 404) return null;
          throw e;
        });
        if (f && !f.trashed) continue;
        await remove("photos", p.id);
        result.removed++;
      }
    const left = new Set((await all("photos")).map((p) => p.run));
    for (const r of await all("runs"))
      if (r.importedFromDrive && !left.has(r.id)) await remove("runs", r.id);
    onStatus(
      `Drive loaded · ${result.added} new, ${result.replaced} updated, ${result.removed} removed` +
        (result.skipped
          ? `, ${result.skipped} skipped (incomplete or changed here)`
          : "") +
        ".",
    );
    return result;
  });
}
export async function sync(onStatus = () => {}) {
  if (busy) return;
  busy = true;
  const work = async () => {
    try {
      if (!connected())
        throw Error("Connect Google Drive to upload your saved photos.");
      const removed = await emptyTrash(onStatus);
      const root = await folder("root", "BottleCapture Dataset");
      await setting("driveRoot", root);
      const runs = await all("runs");
      let uploaded = 0;
      while (true) {
        const pending = (await all("photos")).filter((p) => !p.synced);
        if (!pending.length) break;
        for (let i = 0; i < pending.length; i++) {
          let p = await get("photos", pending[i].id);
          if (!p || p.synced) continue;
          const r = await get("runs", p.run);
          if (!r) continue;
          onStatus(`Uploading ${i + 1} of ${pending.length} · ${p.name}`);
          const b = await folder(r.bottle, r.bottle, root),
            instance = await folder(r.bottle + "/" + r.instance, r.instance, b),
            sess = await folder(
              r.id,
              r.session + "_" + r.id.slice(0, 8),
              instance,
            ),
            level = await folder(
              r.id + "/" + p.level,
              "L" + String(p.level).padStart(2, "0"),
              sess,
            );
          if (!p.cloud) {
            p.cloud = { image: await nextId(), label: await nextId() };
            await put("photos", p);
          }
          const image = await ensureFile(
            p.cloud.image,
            { name: p.name, parents: [level], mimeType: "image/jpeg" },
            p.blob,
          );
          if (image.trashed || Number(image.size) !== p.blob.size)
            throw Error(
              "Cloud photo size differs or the photo is in Trash. Check Drive before continuing.",
            );
          const label = new Blob([JSON.stringify(labelFor(p, r), null, 2)], {
            type: "application/json",
          });
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
        }
      }
      onStatus(
        uploaded
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
