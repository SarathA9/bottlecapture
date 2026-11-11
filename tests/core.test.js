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
// Your B02 fills: aim at the gaps, never repeat an amount.
{
  const b02 = [0, 40, 65, 100, 145, 180, 195, 225, 270, 305, 350, 435, 480].map(
    (mass) => ({ mass }),
  );
  const seen = new Set();
  for (let i = 0; i < 400; i++) {
    const t = suggestTarget(500, b02);
    seen.add(t);
    assert.ok(
      b02.every((f) => Math.abs(f.mass - t) >= 10),
      "no repeat of an existing fill: " + t,
    );
    assert.ok(t > 350 && t < 435, "aims at the biggest gap 350–435 g: " + t);
  }
  assert.ok(seen.size > 3, "still random inside the gap");
  // Amounts used in another split are avoided too, while others are free.
  for (let i = 0; i < 100; i++) {
    const t = suggestTarget(500, [], Math.random, [{ mass: 250 }]);
    assert.ok(Math.abs(t - 250) >= 10);
  }
  // A crowded bottle still gets a suggestion.
  const dense = Array.from({ length: 101 }, (_, i) => ({ mass: i * 5 }));
  assert.ok(Number.isFinite(suggestTarget(500, dense)));
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

// Random reference shots.
{
  const { pickShot, allCombos, comboKey, refSpots } =
    await import("../dist/core.js");
  const { referenceSvg } = await import("../dist/refshot.js");
  assert.equal(allCombos().length, 3 * 3 * 3 * 6);
  // Same shot, same picture (stable across re-renders and reloads).
  assert.deepEqual(
    pickShot({ seed: "run:1:0:0" }),
    pickShot({ seed: "run:1:0:0" }),
  );
  // A whole fill never repeats a combination, and the first four photos use four spots.
  const fill = [];
  for (let i = 0; i < 162; i++)
    fill.push(pickShot({ seed: `run:1:${i}:0`, inFill: fill }));
  assert.equal(
    new Set(fill.map(comboKey)).size,
    162,
    "no repeat inside one fill",
  );
  assert.equal(
    new Set(fill.slice(0, 4).map((c) => c.spot)).size,
    4,
    "four different spots first",
  );
  // Avoids combinations from recent fills of the bottle while others are left.
  const recent = allCombos().slice(0, 150);
  for (let i = 0; i < 12; i++) {
    const c = pickShot({ seed: `x:${i}`, recent });
    assert.ok(
      !recent.some((r) => comboKey(r) === comboKey(c)),
      "avoids recent combinations",
    );
  }
  // When everything was used recently, it still picks something new for this fill.
  const busy = pickShot({
    seed: "y",
    recent: allCombos(),
    inFill: allCombos().slice(0, 3),
  });
  assert.ok(
    !allCombos()
      .slice(0, 3)
      .some((r) => comboKey(r) === comboKey(busy)),
  );
  // Words and drawing for every combination, including spots that are not drawn.
  for (const c of [
    ...allCombos(),
    { facing: "front", camHeight: "eye", distance: "mid", spot: "Desk" },
  ]) {
    const svg = referenceSvg(c);
    assert.ok(
      svg.startsWith("<svg") &&
        !svg.includes("NaN") &&
        !svg.includes("undefined"),
      comboKey(c),
    );
  }
  assert.ok(refSpots.includes("In hand"));
  console.log(
    "PASS: reference shots: random, stable per shot, no repeats in a fill, four spots first, avoid recent fills, drawable.",
  );
}
