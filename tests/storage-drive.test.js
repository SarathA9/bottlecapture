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
// Which Google account the mock is serving.
let me = "test@example.invalid";
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
        permissionId:
          me === "test@example.invalid" ? "test-owner" : "friend-owner",
        emailAddress: me,
      },
    });
  if (path.endsWith("/generateIds"))
    return response({ ids: ["id" + ++sequence] });
  // Drive trashes everything inside a trashed folder.
  const trashed = (f) =>
    !!f && (f.trashed || (f.parents || []).some((x) => trashed(files.get(x))));
  if (method === "GET" && path.endsWith("/files")) {
    const terms = (u.searchParams.get("q") || "").split(" and ");
    const match = (f) =>
      terms.every((t) => {
        let m;
        if ((m = t.match(/^\((.*)\)$/)))
          return m[1].split(" or ").some((x) => {
            const id = x.match(/^'(.*)' in parents$/)[1];
            return !!f.parents?.includes(id);
          });
        if (t === "sharedWithMe = true") return !!f.sharedWith?.includes(me);
        if ((m = t.match(/^name = '(.*)'$/))) return f.name === m[1];
        if ((m = t.match(/^mimeType = '(.*)'$/))) return f.mimeType === m[1];
        if ((m = t.match(/^'(.*)' in parents$/)))
          return m[1] === "root"
            ? !f.parents?.length && f.owners[0].emailAddress === me
            : !!f.parents?.includes(m[1]);
        if (t === "trashed = false") return !trashed(f);
        throw Error("Unsupported test query " + t);
      });
    return response({ files: [...files.values()].filter(match) });
  }
  if (method === "GET") {
    const id = path.split("/").pop();
    if (!files.has(id)) return response({ error: { message: "missing" } }, 404);
    const f = files.get(id);
    if (u.searchParams.get("alt") === "media") return new Response(f.data);
    return response({ ...f, trashed: trashed(f) });
  }
  if (method === "PATCH") {
    const id = path.split("/").pop();
    if (!files.has(id)) return response({ error: { message: "missing" } }, 404);
    if (files.get(id).owners[0].emailAddress !== me)
      return response(
        { error: { message: "insufficientFilePermissions" } },
        403,
      );
    const f = { ...files.get(id), ...JSON.parse(opts.body) };
    files.set(id, f);
    return response(f);
  }
  if (method === "POST") {
    let meta, size, data;
    if (typeof opts.body === "string") meta = JSON.parse(opts.body);
    else {
      const text = await opts.body.text(),
        boundary = opts.headers["Content-Type"].split("boundary=")[1],
        parts = text.split("--" + boundary);
      meta = JSON.parse(parts[1].split("\r\n\r\n")[1].trim());
      data = parts[2].split("\r\n\r\n").slice(1).join("\r\n\r\n").slice(0, -2);
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
      mimeType: meta.mimeType,
      parents: meta.parents || [],
      owners: [{ emailAddress: me }],
      createdTime: new Date(Date.now() + sequence).toISOString(),
      data,
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

// Second device: a fresh browser with the same Google account loads the dataset.
{
  const {
    remove,
    put: put2,
    setting: setting2,
  } = await import("../dist/db.js");
  const keepOwner = await setting2("driveOwner");
  // Phone: one session with two uploaded photos.
  const phoneRun = {
    ...r,
    id: "run6",
    session: "S06",
    fills: { 4: { gross: 800, mass: 300 } },
  };
  await put2("runs", phoneRun);
  await addPhoto({
    ...p,
    id: "run6:4:0",
    run: "run6",
    level: 4,
    shot: 0,
    mass: 300,
    gross: 800,
    name: "B04_S06_L04_A_01.jpg",
    blob: new Blob(["phone-A"], { type: "image/jpeg" }),
  });
  await addPhoto({
    ...p,
    id: "run6:4:1",
    run: "run6",
    level: 4,
    shot: 1,
    mass: 300,
    gross: 800,
    name: "B04_S06_L04_B_02.jpg",
    blob: new Blob(["phone-B!"], { type: "image/jpeg" }),
  });
  await sync();
  const rootBefore = await setting2("folder:root");
  const phoneCloud = (await get("photos", "run6:4:0")).cloud;
  // Laptop: empty local storage.
  for (const store of ["runs", "photos", "settings"])
    for (const x of await all(store)) await remove(store, x.id);
  await setting2("driveOwner", keepOwner);
  assert.equal((await all("photos")).length, 0);
  const res = await drv.pull();
  assert.equal(res.added, 3); // run1's photo plus the two phone photos
  const laptopRun = await get("runs", "run6");
  assert.equal(laptopRun.session, "S06");
  assert.equal(laptopRun.tare, 500);
  assert.equal(laptopRun.fills[4].mass, 300);
  const a = await get("photos", "run6:4:0");
  assert.equal(await a.blob.text(), "phone-A");
  assert.equal(a.synced, true);
  assert.equal(a.mass, 300);
  assert.deepEqual(a.cloud, phoneCloud);
  assert.equal(await setting2("folder:root"), rootBefore);
  // Pulling again downloads nothing new.
  assert.deepEqual(await drv.pull(), {
    added: 0,
    replaced: 0,
    removed: 0,
    skipped: 0,
  });
  // Laptop uploads a new photo into an existing level: no duplicate root or folders.
  const folderCount = [...files.values()].filter(
    (f) => f.mimeType === "application/vnd.google-apps.folder",
  ).length;
  await addPhoto({
    ...p,
    id: "run6:4:2",
    run: "run6",
    level: 4,
    shot: 2,
    mass: 300,
    gross: 800,
    name: "B04_S06_L04_C_03.jpg",
  });
  await sync();
  assert.equal(
    [...files.values()].filter(
      (f) => f.mimeType === "application/vnd.google-apps.folder",
    ).length,
    folderCount,
  );
  // Fresh device with no stored folder IDs reuses the existing root by name.
  await remove("settings", "folder:root");
  await remove("settings", "folder:B04");
  await addPhoto({
    ...p,
    id: "run6:4:3",
    run: "run6",
    level: 4,
    shot: 3,
    mass: 300,
    gross: 800,
    name: "B04_S06_L04_D_04.jpg",
  });
  await sync();
  assert.equal(await setting2("folder:root"), rootBefore);
  assert.equal(
    [...files.values()].filter(
      (f) => f.mimeType === "application/vnd.google-apps.folder",
    ).length,
    folderCount,
  );
  // A retake on the other device: old Drive files trashed, new ones present for the same slot.
  const old = await get("photos", "run6:4:1");
  files.get(old.cloud.image).trashed = true;
  files.get(old.cloud.label).trashed = true;
  const lvl = files.get(old.cloud.label).parents[0];
  files.set("retakeImg", {
    owners: [{ emailAddress: me }],
    id: "retakeImg",
    name: old.name,
    mimeType: "image/jpeg",
    parents: [lvl],
    size: "6",
    data: "retake",
    trashed: false,
  });
  const lbl = JSON.stringify({
    ...JSON.parse(files.get(old.cloud.label).data),
    water_mass_g: 301,
  });
  files.set("retakeLbl", {
    owners: [{ emailAddress: me }],
    id: "retakeLbl",
    name: old.name.replace(".jpg", ".json"),
    mimeType: "application/json",
    parents: [lvl],
    size: String(lbl.length),
    data: lbl,
    trashed: false,
  });
  const res2 = await drv.pull();
  assert.equal(res2.replaced, 1);
  assert.equal(res2.removed, 0);
  const re = await get("photos", "run6:4:1");
  assert.equal(await re.blob.text(), "retake");
  assert.equal(re.mass, 301);
  // A session deleted on the other device disappears here too.
  files.get(await setting2("folder:run6")).trashed = true;
  const res3 = await drv.pull();
  assert.equal(res3.removed, 4);
  assert.equal(await get("runs", "run6"), undefined);
  assert.equal((await all("photos")).filter((x) => x.run === "run6").length, 0);
  // Unsent local photos are never removed by a pull.
  await put2("runs", { ...r, id: "run7", session: "S07" });
  await addPhoto({
    ...p,
    id: "run7:1:0",
    run: "run7",
    level: 1,
    name: "local.jpg",
  });
  await drv.pull();
  assert.ok(await get("photos", "run7:1:0"));
  console.log(
    "PASS: second device loads Drive sessions, reuses folders, mirrors retakes and deletes, keeps unsent photos.",
  );
}

// Two Google accounts share one dataset folder.
{
  const db = await import("../dist/db.js");
  const wipe = async () => {
    for (const store of ["runs", "photos", "settings"])
      for (const x of await all(store)) await db.remove(store, x.id);
  };
  // Sarath's account owns the dataset and has one session with a photo.
  await db.put("runs", {
    ...r,
    id: "runS",
    session: "S10",
    bottle: "B01",
    fills: {},
  });
  await addPhoto({
    ...p,
    id: "runS:2:0",
    run: "runS",
    level: 2,
    name: "B01_S10_L02_A_01.jpg",
    blob: new Blob(["sarath"], { type: "image/jpeg" }),
  });
  await sync();
  const sarathRoot = await db.setting("folder:root");
  const sarathFolder = await db.setting("folder:runS");
  // Sarath shares the root folder with his friend (done in Google Drive).
  files.get(sarathRoot).sharedWith = ["friend@example.invalid"];
  const sarathDevice = {};
  for (const store of ["runs", "photos", "settings"])
    sarathDevice[store] = await all(store);

  // Friend's phone: new browser, his own Google account.
  await wipe();
  me = "friend@example.invalid";
  await connect("test.apps.googleusercontent.com");
  await drv.pull();
  assert.equal(
    await db.setting("folder:root"),
    sarathRoot,
    "friend finds the shared folder",
  );
  assert.equal((await get("runs", "runS")).uploadedBy, "test@example.invalid");
  await db.put("runs", {
    ...r,
    id: "runF",
    session: "S11",
    bottle: "B01",
    instance: "I02",
    fills: {},
  });
  await addPhoto({
    ...p,
    id: "runF:3:0",
    run: "runF",
    level: 3,
    name: "B01_I02_S11_L03_A_01.jpg",
    blob: new Blob(["friend"], { type: "image/jpeg" }),
  });
  await sync();
  const friendImg = (await get("photos", "runF:3:0")).cloud.image;
  assert.equal(
    files.get(friendImg).owners[0].emailAddress,
    "friend@example.invalid",
  );
  assert.equal(
    [...files.values()].filter((f) => f.name === "BottleCapture Dataset")
      .length,
    1,
    "no second root",
  );
  assert.equal(
    [...files.values()].filter(
      (f) => f.name === "B01" && f.parents.includes(sarathRoot),
    ).length,
    1,
    "reuses B01",
  );
  // The friend cannot trash Sarath's session: the job is dropped instead of blocking sync.
  await drv.exclusive(async () => {
    await db.deleteRun("runS");
    await drv.emptyTrash();
  });
  assert.equal(files.get(sarathFolder).trashed, false);
  assert.deepEqual(await db.trashQueue(), []);
  await sync();

  // Back on Sarath's device: he loads his friend's photos.
  await wipe();
  for (const store of ["runs", "photos", "settings"])
    for (const x of sarathDevice[store]) await db.put(store, x);
  me = "test@example.invalid";
  await connect("test.apps.googleusercontent.com");
  await drv.pull();
  const fromFriend = await get("photos", "runF:3:0");
  assert.equal(await fromFriend.blob.text(), "friend");
  assert.equal(
    (await get("runs", "runF")).uploadedBy,
    "friend@example.invalid",
  );
  assert.ok(
    await get("photos", "runS:2:0"),
    "Sarath's own photo is still here",
  );
  console.log(
    "PASS: shared folder: friend finds and uploads into it, cannot trash others' files, owner loads friend's photos.",
  );
}
