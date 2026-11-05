const ready = new Promise((resolve, reject) => {
  const q = indexedDB.open("bottlecapture-v1", 1);
  q.onupgradeneeded = () => {
    const d = q.result;
    d.createObjectStore("runs", { keyPath: "id" });
    d.createObjectStore("photos", { keyPath: "id" });
    d.createObjectStore("settings", { keyPath: "id" });
  };
  q.onsuccess = () => resolve(q.result);
  q.onerror = () => reject(q.error);
});
export async function all(store) {
  const d = await ready;
  return new Promise((res, rej) => {
    const q = d.transaction(store).objectStore(store).getAll();
    q.onsuccess = () => res(q.result);
    q.onerror = () => rej(q.error);
  });
}
export async function get(store, id) {
  const d = await ready;
  return new Promise((res, rej) => {
    const q = d.transaction(store).objectStore(store).get(id);
    q.onsuccess = () => res(q.result);
    q.onerror = () => rej(q.error);
  });
}
export async function put(store, obj) {
  const d = await ready;
  return new Promise((res, rej) => {
    const t = d.transaction(store, "readwrite");
    t.objectStore(store).put(obj);
    t.oncomplete = () => res(obj);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error || Error("Storage write cancelled."));
  });
}
export async function remove(store, id) {
  const d = await ready;
  return new Promise((res, rej) => {
    const t = d.transaction(store, "readwrite");
    t.objectStore(store).delete(id);
    t.oncomplete = () => res();
    t.onerror = () => rej(t.error);
  });
}
export async function addPhoto(obj) {
  const d = await ready;
  return new Promise((res, rej) => {
    const t = d.transaction("photos", "readwrite");
    t.objectStore("photos").add(obj);
    t.oncomplete = () => res(obj);
    t.onerror = () =>
      rej(
        Error(
          "This shot already exists, or storage is full. Your photo was not overwritten.",
        ),
      );
  });
}
export async function setting(id, value) {
  if (value === undefined) return (await get("settings", id))?.value;
  await put("settings", { id, value });
  return value;
}

// Drive file/folder IDs waiting to be moved to Google Drive Trash.
// Stored with the local change in one transaction so the cloud copy is never forgotten.
const TRASH = "trashQueue";
function queueTrash(settings, ids) {
  const q = settings.get(TRASH);
  q.onsuccess = () => {
    const list = q.result?.value || [];
    for (const id of ids) if (id && !list.includes(id)) list.push(id);
    settings.put({ id: TRASH, value: list });
  };
}
export async function queueTrashIds(ids) {
  const d = await ready;
  return new Promise((resolve, reject) => {
    const t = d.transaction("settings", "readwrite");
    queueTrash(t.objectStore("settings"), ids);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}
export async function trashQueue() {
  return (await setting(TRASH)) || [];
}
export async function unqueueTrash(id) {
  const d = await ready;
  return new Promise((resolve, reject) => {
    const t = d.transaction("settings", "readwrite"),
      s = t.objectStore("settings"),
      q = s.get(TRASH);
    q.onsuccess = () =>
      s.put({
        id: TRASH,
        value: (q.result?.value || []).filter((x) => x !== id),
      });
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

// Remove a session, all its photos and its Drive folder references in one transaction.
// Returns the Drive IDs queued for Trash.
export async function deleteRun(id) {
  const d = await ready;
  return new Promise((resolve, reject) => {
    const t = d.transaction(["runs", "photos", "settings"], "readwrite"),
      runs = t.objectStore("runs"),
      photos = t.objectStore("photos"),
      settings = t.objectStore("settings"),
      cloud = [];
    const q = runs.get(id);
    q.onsuccess = () => {
      if (!q.result) {
        t.abort();
        return;
      }
      runs.delete(id);
      const folderKeys = [
        "folder:" + id,
        ...Array.from({ length: 11 }, (_, l) => "folder:" + id + "/" + l),
      ];
      const sessionFolder = settings.get(folderKeys[0]);
      sessionFolder.onsuccess = () => {
        // Trashing the session folder trashes every photo and label inside it.
        if (sessionFolder.result?.value) cloud.push(sessionFolder.result.value);
        const c = photos.openCursor();
        c.onsuccess = () => {
          const cur = c.result;
          if (!cur) {
            for (const k of folderKeys) settings.delete(k);
            queueTrash(settings, cloud);
            return;
          }
          if (cur.value.run === id) {
            if (!sessionFolder.result?.value && cur.value.cloud)
              cloud.push(cur.value.cloud.image, cur.value.cloud.label);
            cur.delete();
          }
          cur.continue();
        };
      };
    };
    t.oncomplete = () => resolve(cloud);
    t.onerror = () => reject(t.error);
    t.onabort = () =>
      reject(
        t.error ||
          Error("This session no longer exists. Refresh and try again."),
      );
  });
}

// Replace a saved photo with a retake under the same slot ID.
// The old Drive JPEG and JSON are queued for Trash in the same transaction.
export async function replacePhoto(obj) {
  const d = await ready;
  return new Promise((resolve, reject) => {
    const t = d.transaction(["photos", "settings"], "readwrite"),
      photos = t.objectStore("photos");
    const q = photos.get(obj.id);
    q.onsuccess = () => {
      const old = q.result;
      if (old?.cloud)
        queueTrash(t.objectStore("settings"), [
          old.cloud.image,
          old.cloud.label,
        ]);
      photos.put(obj);
    };
    t.oncomplete = () => resolve(obj);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || Error("Retake could not be saved."));
  });
}

// Correct the measured weight of one fill. Every photo of that fill gets the new
// label, and its old Drive label (JSON) is replaced at the next sync.
export async function correctFill(runId, level, gross, mass) {
  const d = await ready;
  return new Promise((resolve, reject) => {
    const t = d.transaction(["runs", "photos", "settings"], "readwrite"),
      runs = t.objectStore("runs"),
      photos = t.objectStore("photos"),
      old = [];
    let changed = 0;
    const q = runs.get(runId);
    q.onsuccess = () => {
      const r = q.result;
      if (!r?.fills?.[level]) {
        t.abort();
        return;
      }
      r.fills[level] = {
        ...r.fills[level],
        gross,
        mass,
        correctedAt: new Date().toISOString(),
      };
      runs.put(r);
      const c = photos.openCursor();
      c.onsuccess = () => {
        const cur = c.result;
        if (!cur) {
          queueTrash(t.objectStore("settings"), old);
          return;
        }
        const p = cur.value;
        if (p.run === runId && p.level === level && !p.refillMeasuredAt) {
          if (p.cloud?.label) old.push(p.cloud.label);
          cur.update({
            ...p,
            gross,
            mass,
            synced: false,
            ...(p.cloud ? { cloud: { image: p.cloud.image } } : {}),
          });
          changed++;
        }
        cur.continue();
      };
    };
    t.oncomplete = () => resolve(changed);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || Error("This fill no longer exists."));
  });
}
export async function restartRun(id, newId) {
  const d = await ready;
  return new Promise((resolve, reject) => {
    const t = d.transaction("runs", "readwrite"),
      store = t.objectStore("runs");
    let fresh;
    const q = store.get(id);
    q.onsuccess = () => {
      const old = q.result;
      if (!old || old.archived) {
        t.abort();
        return;
      }
      const now = new Date().toISOString();
      fresh = { ...old, id: newId, fills: {}, created: now, restartedFrom: id };
      delete fresh.archived;
      store.put({ ...old, archived: now });
      store.add(fresh);
    };
    t.oncomplete = () => resolve(fresh);
    t.onerror = () => reject(t.error);
    t.onabort = () =>
      reject(
        t.error || Error("Session was already reset. Refresh and try again."),
      );
  });
}
