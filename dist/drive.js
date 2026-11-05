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
import { labelFor } from "./core.js";
let token = "",
  expires = 0,
  busy = false;
export const connected = () => !!token && Date.now() < expires;
// Full Drive access lets two Google accounts work in one shared dataset folder.
// (drive.file only sees files this account created, so a friend's uploads were invisible.)
export const SCOPE = "https://www.googleapis.com/auth/drive";
const ROOT_NAME = "BottleCapture Dataset";
// Delete marker. In a shared My Drive folder only a file's owner can trash it, so any
// collaborator marks a file or folder as deleted, and the owner's device trashes it later.
const DELETED = "bottlecaptureDeleted";
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
    return await api(
      "/files/" + id + "?fields=id,name,size,trashed,appProperties",
    );
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
      "/files?uploadType=multipart&fields=id,name,size,trashed,appProperties",
      {
        upload: true,
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
        };
      r.uploadedBy ||= sessF.owners?.[0]?.emailAddress;
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
      let uploaded = 0;
      const blocked = new Set();
      while (true) {
        const pending = (await all("photos")).filter(
          (p) => !p.synced && !blocked.has(p.id),
        );
        if (!pending.length) break;
        for (let i = 0; i < pending.length; i++) {
          let p = await get("photos", pending[i].id);
          if (!p || p.synced) continue;
          const r = await get("runs", p.run);
          if (!r) continue;
          onStatus(`Uploading ${i + 1} of ${pending.length} · ${p.name}`);
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
          } catch (e) {
            if (e.code !== "deleted") throw e;
            // Kept on this device, never removed automatically. Export or delete it here.
            blocked.add(p.id);
          }
        }
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
