import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { put, get, addPhoto, all } from "../dist/db.js";
import { connect, sync } from "../dist/drive.js";
const r = {
  id: "run1",
  bottle: "B04",
  instance: "I01",
  session: "S01",
  setup: "SET01",
  split: "train",
  tare: 500,
  reference: 750,
  resolution: 0.1,
  background: "wall",
  lighting: "daylight",
};
const p = {
  id: "run1:3:0",
  run: "run1",
  level: 3,
  shot: 0,
  name: "photo.jpg",
  path: "images/photo.jpg",
  mass: 224.7,
  gross: 724.7,
  visibility: "hidden",
  width: 2000,
  height: 3000,
  blob: new Blob(["original-photo"], { type: "image/jpeg" }),
  takenAt: "2026-11-03",
  synced: false,
};
await put("runs", r);
await addPhoto(p);
await assert.rejects(addPhoto({ ...p, mass: 900 }));
assert.equal((await get("photos", p.id)).mass, 224.7);
assert.equal(await (await get("photos", p.id)).blob.text(), "original-photo");
const files = new Map();
let sequence = 0,
  imageCreates = 0,
  failLabel = true;
globalThis.google = {
  accounts: {
    oauth2: {
      initTokenClient: (config) => ({
        requestAccessToken: () =>
          config.callback({ access_token: "TEST_ONLY", expires_in: 3600 }),
      }),
    },
  },
};
globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(url),
    path = u.pathname,
    method = opts.method || "GET";
  const response = (data, status = 200) =>
    new Response(JSON.stringify(data), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  if (path.endsWith("/about"))
    return response({
      user: {
        permissionId: "test-owner",
        emailAddress: "test@example.invalid",
      },
    });
  if (path.endsWith("/generateIds"))
    return response({ ids: ["id" + ++sequence] });
  if (method === "GET") {
    const id = path.split("/").pop();
    return files.has(id)
      ? response(files.get(id))
      : response({ error: { message: "missing" } }, 404);
  }
  if (method === "PATCH") {
    const id = path.split("/").pop();
    if (!files.has(id)) return response({ error: { message: "missing" } }, 404);
    const f = { ...files.get(id), ...JSON.parse(opts.body) };
    files.set(id, f);
    return response(f);
  }
  if (method === "POST") {
    let meta, size;
    if (typeof opts.body === "string") meta = JSON.parse(opts.body);
    else {
      const text = await opts.body.text(),
        boundary = opts.headers["Content-Type"].split("boundary=")[1],
        parts = text.split("--" + boundary);
      meta = JSON.parse(parts[1].split("\r\n\r\n")[1].trim());
      const data = parts[2]
        .split("\r\n\r\n")
        .slice(1)
        .join("\r\n\r\n")
        .slice(0, -2);
      size = new Blob([data]).size;
      if (meta.mimeType === "application/json" && failLabel) {
        failLabel = false;
        return response({ error: { message: "temporary failure" } }, 503);
      }
      if (meta.mimeType === "image/jpeg") imageCreates++;
    }
    const f = {
      id: meta.id,
      name: meta.name,
      ...(size === undefined ? {} : { size: String(size) }),
      trashed: false,
    };
    files.set(meta.id, f);
    return response(f);
  }
  throw Error("Unexpected test request " + url);
};
await connect("test.apps.googleusercontent.com");
await assert.rejects(sync(), /temporary failure/);
const pending = await get("photos", p.id);
assert.equal(pending.synced, false);
assert.ok(pending.cloud.image);
const ids = { ...pending.cloud };
await sync();
const saved = await get("photos", p.id);
assert.equal(saved.synced, true);
assert.deepEqual(saved.cloud, ids);
assert.equal(imageCreates, 1);
assert.equal((await all("photos")).length, 1);
console.log(
  "PASS: atomic photo save, duplicate rejection, original bytes, interrupted Drive label upload, persisted IDs and retry without duplicate JPEG. Mock provider only.",
);

const session = new Map();
globalThis.sessionStorage = {
  getItem: (k) => session.get(k) || null,
  setItem: (k, v) => session.set(k, v),
  removeItem: (k) => session.delete(k),
};
await connect("test.apps.googleusercontent.com");
const reloaded = await import("../dist/drive.js?reload");
assert.equal(reloaded.connected(), false);
assert.equal(await reloaded.restore("test.apps.googleusercontent.com"), true);
assert.equal(reloaded.connected(), true);
assert.equal(await reloaded.restore("other.apps.googleusercontent.com"), false);
await connect("test.apps.googleusercontent.com");
const key = "bottlecapture-drive-session";
const expired = JSON.parse(session.get(key));
expired.expires = Date.now() - 1;
session.set(key, JSON.stringify(expired));
assert.equal(await reloaded.restore("test.apps.googleusercontent.com"), false);
globalThis.google.accounts.oauth2.revoke = () => {};
await connect("test.apps.googleusercontent.com");
const original = await import("../dist/drive.js");
original.disconnect();
assert.equal(session.size, 0);
assert.equal(original.connected(), false);
console.log(
  "PASS: Drive refresh restoration, client mismatch, expiry and disconnect clearing.",
);

const { restartRun } = await import("../dist/db.js");
const restarted = await restartRun("run1", "run2");
assert.deepEqual(restarted.fills, {});
assert.equal(restarted.session, r.session);
assert.ok((await get("runs", "run1")).archived);
assert.equal((await get("photos", p.id)).run, "run1");
assert.equal((await all("photos")).filter((p) => p.run === "run2").length, 0);
await assert.rejects(restartRun("run1", "run3"));
assert.equal(await get("runs", "run3"), undefined);
console.log(
  "PASS: atomic session restart, preserved backup and duplicate reset rejection.",
);

// Retake: replaces the saved photo and moves its old Drive files to Trash.
const { deleteRun, replacePhoto, trashQueue, setting } =
  await import("../dist/db.js");
const drv = await import("../dist/drive.js");
await connect("test.apps.googleusercontent.com");
const live = { ...r, id: "run4", session: "S04" };
await put("runs", live);
const shotA = {
  ...p,
  id: "run4:2:0",
  run: "run4",
  level: 2,
  name: "a.jpg",
  path: "images/a.jpg",
};
const shotB = {
  ...p,
  id: "run4:2:1",
  run: "run4",
  level: 2,
  shot: 1,
  name: "b.jpg",
  path: "images/b.jpg",
};
await addPhoto(shotA);
await addPhoto(shotB);
await sync();
const before = await get("photos", shotA.id);
assert.equal(before.synced, true);
await drv.exclusive(() =>
  replacePhoto({
    ...shotA,
    blob: new Blob(["retake-bytes"], { type: "image/jpeg" }),
    retakenAt: "now",
    synced: false,
  }),
);
assert.deepEqual(await trashQueue(), [before.cloud.image, before.cloud.label]);
assert.equal((await all("photos")).filter((x) => x.id === shotA.id).length, 1);
await sync();
const after = await get("photos", shotA.id);
assert.equal(after.synced, true);
assert.notEqual(after.cloud.image, before.cloud.image);
assert.equal(files.get(before.cloud.image).trashed, true);
assert.equal(files.get(before.cloud.label).trashed, true);
assert.equal(files.get(after.cloud.image).trashed, false);
assert.equal(Number(files.get(after.cloud.image).size), 12);
assert.deepEqual(await trashQueue(), []);
console.log(
  "PASS: retake replaces the local photo, trashes old Drive files and uploads the new one.",
);

// Delete session: removes the run and its photos locally, then trashes its Drive folder.
const sessionFolder = await setting("folder:run4");
assert.ok(sessionFolder);
await drv.exclusive(async () => {
  const queued = await deleteRun("run4");
  assert.deepEqual(queued, [sessionFolder]);
  await drv.emptyTrash();
});
assert.equal(await get("runs", "run4"), undefined);
assert.equal((await all("photos")).filter((x) => x.run === "run4").length, 0);
assert.equal(await setting("folder:run4"), undefined);
assert.equal(await setting("folder:run4/2"), undefined);
assert.equal(files.get(sessionFolder).trashed, true);
assert.equal((await all("photos")).filter((x) => x.run === "run1").length, 1);
assert.deepEqual(await trashQueue(), []);
await assert.rejects(deleteRun("run4"));
console.log(
  "PASS: delete session removes local data, trashes the Drive session folder and leaves other sessions untouched.",
);

// Offline delete: the Drive folder stays queued and is trashed at the next sync.
const offline = { ...r, id: "run5", session: "S05" };
await put("runs", offline);
await addPhoto({ ...p, id: "run5:1:0", run: "run5", level: 1, name: "c.jpg" });
await sync();
const folder5 = await setting("folder:run5");
await deleteRun("run5");
assert.deepEqual(await trashQueue(), [folder5]);
assert.equal(files.get(folder5).trashed, false);
await sync();
assert.equal(files.get(folder5).trashed, true);
assert.deepEqual(await trashQueue(), []);
console.log(
  "PASS: delete while offline queues the Drive folder and trashes it at the next sync.",
);
