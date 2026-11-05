import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import {
  mass,
  waterMass,
  checkRun,
  photoName,
  photoPath,
  csv,
  labelFor,
  suggestTarget,
  coverage,
  planFor,
  PROTOCOL,
} from "../dist/core.js";
import { zip, crc32 } from "../dist/zip.js";
import fs from "node:fs";
const r = {
  id: "abcdefgh-1234",
  bottle: "B04",
  instance: "I01",
  session: "S01",
  setup: "SET01",
  split: "train",
  tare: 500,
  reference: 750,
  resolution: 0.1,
  background: "wall",
  lighting: "window",
};
assert.equal(mass("224,7"), 224.7);
assert.throws(() => mass(""));
assert.throws(() => mass("NaN"));
assert.throws(() => mass("-1"));
assert.equal(waterMass(r, 3, 724.7), 224.7);
assert.throws(() => waterMass(r, 0, 501));
assert.throws(() => waterMass(r, 3, 400));
checkRun(r, []);
assert.throws(() => checkRun({ ...r, split: "validation" }, [r]));
assert.throws(() => checkRun({ ...r, reference: 700 }, [r]));
assert.equal(photoName(r, 3, 0), "B04_I01_S01_abcdefgh_L03_A_01.jpg");
assert.match(photoPath(r, 3, 0), /^images\/B04\/I01\/S01_abcdefgh\/L03\//);
const p = {
  id: "a",
  name: "a.jpg",
  path: "images/a.jpg",
  level: 3,
  shot: 0,
  mass: 224.7,
  gross: 724.7,
  visibility: "hidden",
  width: 2000,
  height: 3000,
  blob: new Blob(["jpeg"]),
  takenAt: "2026-11-03",
};
assert.equal(labelFor(p, r).water_mass_g, 224.7);
assert.equal(labelFor(p, r).target_water_g, 225);
assert.match(csv([labelFor(p, r)]), /"224.7"/);
assert.equal(crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
const z = await zip([
  ["BottleDataset/a.txt", new Blob(["hello"])],
  ["BottleDataset/labels.csv", new Blob([csv([labelFor(p, r)])])],
]);
fs.writeFileSync(
  join(tmpdir(), "bottlecapture-test.zip"),
  Buffer.from(await z.arrayBuffer()),
);
// Protocol 2: free fills, balanced random targets, tagged photos.
const v2 = { ...r, protocol: PROTOCOL };
assert.equal(waterMass(v2, 1, 501), 1); // any fill may be near empty
assert.throws(() => waterMass(v2, 1, 500 + 750 * 1.2)); // typo guard stays
assert.equal(photoName(v2, 3, 0), "B04_I01_S01_abcdefgh_F03_P01.jpg");
assert.match(photoPath(v2, 12, 7), /\/F12\/B04_I01_S01_abcdefgh_F12_P08\.jpg$/);
// Targets go to the emptiest tenth of the range.
const fills = [0.05, 0.15, 0.25, 0.35, 0.45, 0.55, 0.65, 0.85, 0.95].map(
  (x) => ({ mass: x * 750 }),
);
for (let i = 0; i < 50; i++) {
  const t = suggestTarget(750, fills);
  assert.ok(t >= 525 && t <= 600, "target in the empty 70–80% bin: " + t);
}
assert.deepEqual(coverage(fills, 750), [1, 1, 1, 1, 1, 1, 1, 0, 1, 1]);
assert.equal(coverage([{ mass: 800 }], 750)[9], 1); // over-full counts as full
for (let i = 0; i < 200; i++) {
  const t = suggestTarget(750, []);
  assert.ok(t >= 0 && t <= 750 && t % 5 === 0);
}
assert.notEqual(planFor(1, 0).text, planFor(2, 0).text); // each fill starts differently
const p2 = {
  ...p,
  level: 3,
  shot: 4,
  target: 410,
  spot: "Window sill",
  facing: "back",
  camHeight: "high",
  distance: "far",
};
const l2 = labelFor(p2, v2);
assert.equal(l2.target_water_g, 410);
assert.equal(l2.spot, "Window sill");
assert.equal(l2.label_facing, "back");
assert.equal(l2.camera_height, "high");
assert.equal(l2.height, 3000); // pixel height is not overwritten by the camera-height tag
assert.equal(l2.protocol, 2);
assert.equal(l2.fill_id, "B04_I01_S01_abcdefgh_F03");
assert.equal(labelFor(p, r).protocol, 1);
assert.equal(labelFor(p, r).view, "A");
console.log(
  "PASS: protocol 2 free fills, balanced targets, shot plan and photo tags.",
);
console.log(
  "PASS: masses, fill validation, leakage grouping, stable reference, naming, labels and ZIP CRC.",
);
