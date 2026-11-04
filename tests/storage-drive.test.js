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
    return response({
      files: [...files.values()]
        .filter(match)
        .map((f) => ({ ...f, ownedByMe: f.owners[0].emailAddress === me })),
    });
  }
  if (method === "GET") {
    const id = path.split("/").pop();
    if (!files.has(id)) return response({ error: { message: "missing" } }, 404);
    const f = files.get(id);
    if (u.searchParams.get("alt") === "media") return new Response(f.data);
    return response({
      ...f,
      trashed: trashed(f),
      ownedByMe: f.owners[0].emailAddress === me,
    });
  }
  if (method === "PATCH") {
    const id = path.split("/").pop();
    if (!files.has(id)) return response({ error: { message: "missing" } }, 404);
    const body = JSON.parse(opts.body),
      old = files.get(id);
    // In a shared My Drive folder only the owner may trash; editors may change metadata.
    if (body.trashed && old.owners[0].emailAddress !== me)
      return response(
        { error: { message: "insufficientFilePermissions" } },
        403,
      );
    const f = {
      ...old,
      ...body,
      appProperties: { ...old.appProperties, ...body.appProperties },
    };
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
// Marked deleted for every collaborator, then trashed by the owner's next Drive check.
assert.ok(files.get(sessionFolder).appProperties.bottlecaptureDeleted);
await drv.pull();
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
assert.ok(files.get(folder5).appProperties.bottlecaptureDeleted);
await drv.pull();
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

// Two Google accounts edit one central dataset, like two people on one git branch.
{
  const db = await import("../dist/db.js");
  const devices = {};
  const save = async (name) => {
    devices[name] = {};
    for (const store of ["runs", "photos", "settings"])
      devices[name][store] = await all(store);
  };
  const open = async (name, account) => {
    for (const store of ["runs", "photos", "settings"])
      for (const x of await all(store)) await db.remove(store, x.id);
    for (const store of ["runs", "photos", "settings"])
      for (const x of devices[name]?.[store] || []) await db.put(store, x);
    me = account;
    await connect("test.apps.googleusercontent.com");
  };
  const SARATH = "test@example.invalid",
    FRIEND = "friend@example.invalid";
  const photo = (run, level, shot, text) => ({
    ...p,
    id: `${run}:${level}:${shot}`,
    run,
    level,
    shot,
    name: `B01_${run}_L0${level}_${shot}.jpg`,
    blob: new Blob([text], { type: "image/jpeg" }),
  });

  // Sarath's phone: one session with two photos, then he shares the folder.
  await open("sarath", SARATH);
  await db.put("runs", {
    ...r,
    id: "runS",
    session: "S10",
    bottle: "B01",
    fills: { 2: { gross: 700, mass: 200 } },
  });
  await addPhoto(photo("runS", 2, 0, "sarath-0"));
  await addPhoto(photo("runS", 2, 1, "sarath-1"));
  await sync();
  const root = await db.setting("folder:root");
  files.get(root).sharedWith = [FRIEND];
  await save("sarath");

  // Friend's phone, his own account: he sees Sarath's session and works in it.
  await open("friend", FRIEND);
  await drv.pull();
  assert.equal(
    await db.setting("folder:root"),
    root,
    "friend uses the shared folder",
  );
  assert.equal(await (await get("photos", "runS:2:0")).blob.text(), "sarath-0");
  // He adds a photo to Sarath's session...
  await addPhoto(photo("runS", 2, 2, "friend-2"));
  // ...retakes one of Sarath's photos...
  const old1 = await get("photos", "runS:2:1");
  await drv.exclusive(() =>
    db.replacePhoto({
      ...old1,
      blob: new Blob(["friend-retake-1"], { type: "image/jpeg" }),
      synced: false,
      cloud: undefined,
    }),
  );
  // ...and starts his own session.
  await db.put("runs", {
    ...r,
    id: "runF",
    session: "S11",
    bottle: "B01",
    instance: "I02",
    fills: {},
  });
  await addPhoto(photo("runF", 3, 0, "friend-own"));
  await sync();
  assert.equal(
    [...files.values()].filter((f) => f.name === "BottleCapture Dataset")
      .length,
    1,
    "one central root",
  );
  assert.ok(
    files.get(old1.cloud.image).appProperties.bottlecaptureDeleted,
    "Sarath's old photo marked deleted",
  );
  assert.equal(
    files.get(old1.cloud.image).trashed,
    false,
    "only the owner can trash it",
  );
  await save("friend");

  // Sarath's phone: one check brings in all of his friend's changes.
  await open("sarath", SARATH);
  const res = await drv.pull();
  assert.equal(
    await (await get("photos", "runS:2:2")).blob.text(),
    "friend-2",
    "friend's new photo",
  );
  assert.equal(
    await (await get("photos", "runS:2:1")).blob.text(),
    "friend-retake-1",
    "friend's retake",
  );
  assert.equal(
    await (await get("photos", "runF:3:0")).blob.text(),
    "friend-own",
    "friend's session",
  );
  assert.equal(
    files.get(old1.cloud.image).trashed,
    true,
    "owner device trashed the replaced photo",
  );
  assert.ok(res.added >= 2 && res.replaced >= 1);
  // Sarath deletes the friend's session.
  const f0 = await get("photos", "runF:3:0");
  await drv.exclusive(async () => {
    await db.deleteRun("runF");
    await drv.emptyTrash();
  });
  await sync();
  await save("sarath");

  // Friend's phone: the deleted session disappears, and his own files go to his Trash.
  await open("friend", FRIEND);
  await drv.pull();
  assert.equal(
    await get("runs", "runF"),
    undefined,
    "session deleted by Sarath is gone here",
  );
  assert.equal(await get("photos", "runF:3:0"), undefined);
  assert.equal(
    files.get(f0.cloud.image).trashed,
    true,
    "friend's device trashed his own files",
  );
  assert.equal(
    await (await get("photos", "runS:2:1")).blob.text(),
    "friend-retake-1",
  );

  // Both retake the same slot at once: the newest upload wins on every device.
  await save("friend");
  const slot = await get("photos", "runS:2:0");
  await drv.exclusive(() =>
    db.replacePhoto({
      ...slot,
      blob: new Blob(["friend-first"], { type: "image/jpeg" }),
      synced: false,
      cloud: undefined,
    }),
  );
  await sync();
  await save("friend");
  await open("sarath", SARATH);
  // Sarath had not pulled yet; his own retake of the same slot uploads later, so it is newer.
  const mine = await get("photos", "runS:2:0");
  await drv.exclusive(() =>
    db.replacePhoto({
      ...mine,
      blob: new Blob(["sarath-later"], { type: "image/jpeg" }),
      synced: false,
      cloud: undefined,
    }),
  );
  await sync();
  await drv.pull();
  assert.equal(
    await (await get("photos", "runS:2:0")).blob.text(),
    "sarath-later",
  );
  await save("sarath");
  await open("friend", FRIEND);
  await drv.pull();
  assert.equal(
    await (await get("photos", "runS:2:0")).blob.text(),
    "sarath-later",
    "same result on both devices",
  );

  // A session deleted elsewhere while this device still has unsent photos in it: those are kept.
  await addPhoto(photo("runS", 2, 3, "unsent"));
  await save("friend");
  await open("sarath", SARATH);
  await drv.exclusive(async () => {
    await db.deleteRun("runS");
    await drv.emptyTrash();
  });
  await save("sarath");
  await open("friend", FRIEND);
  await drv.pull();
  assert.ok(await get("photos", "runS:2:3"), "unsent photo is never removed");
  await sync();
  assert.equal(
    (await get("photos", "runS:2:3")).synced,
    false,
    "and is not uploaded into a deleted session",
  );
  console.log(
    "PASS: two accounts edit one dataset: add, retake, delete in each other's sessions, newest retake wins, unsent photos kept.",
  );
}
