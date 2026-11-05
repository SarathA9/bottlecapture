export const bottles = [
  {
    id: "B01",
    name: "Kondrauer",
    detail: "Prickelnd · 0.7 L · Glass",
    color: "#738b66",
    label: "#edeadd",
    cap: "#8b9581",
  },
  {
    id: "B02",
    name: "Stephanie Brunnen",
    detail: "Labertaler · Mild · Glass",
    color: "#8ba48b",
    label: "#e7e0b2",
    cap: "#baae78",
  },
  {
    id: "B03",
    name: "Stephanie Brunnen",
    detail: "Labertaler · Medium · PET",
    color: "#b8ccc1",
    label: "#efe7d2",
    cap: "#b54e45",
  },
  {
    id: "B04",
    name: "Staatl. Fachingen",
    detail: "Medium · 0.75 L · Glass",
    color: "#6d9473",
    label: "#efece0",
    cap: "#a9aba0",
  },
];
// Legacy fixed views (first protocol). Kept so older sessions still work.
export const shots = [
  [
    "A",
    "Straight ahead",
    "Keep the camera upright, facing the front label. Include the cap and base with space around the bottle.",
    "Eye level",
  ],
  [
    "B",
    "A little above",
    "Raise the camera about 25–30° above the bottle centre. Point down gently. Keep the whole bottle in view.",
    "Above · 25–30°",
  ],
  [
    "C",
    "Above and to the side",
    "Move a little to the right and raise the camera. Include the whole bottle and keep the original label on.",
    "Above + right",
  ],
  [
    "D",
    "A higher view",
    "Raise the camera about 40–45°. Look down at the bottle, keeping the cap and base visible.",
    "Above · 40–45°",
  ],
  [
    "A2",
    "Step back slightly",
    "Use the straight-on view. Step back so the bottle occupies about 65% of the image height. Do not use digital zoom.",
    "Front · farther",
  ],
  [
    "A3",
    "A closer view",
    "Move closer so the whole bottle fills about 85% of the image height. Leave a clear margin around the cap and base.",
    "Front · closer",
  ],
  [
    "B2",
    "Above from the other side",
    "Use a gently elevated view from the left. Keep the complete bottle visible.",
    "Above + left",
  ],
  [
    "C2",
    "A small side angle",
    "Move slightly left from the front view. Keep the bottle upright and the label intact.",
    "Front + left",
  ],
  [
    "D2",
    "Higher and farther",
    "Use the higher view and step back slightly. Leave space around the entire bottle.",
    "High · farther",
  ],
  [
    "A4",
    "A small framing variation",
    "Use the straight-on view and place the bottle slightly off centre. Keep it fully visible and sharp.",
    "Front · off centre",
  ],
];
// Protocol 2: copy the professor's validation photos. One weighed fill, many
// different spots in the creative space, the bottle turned every way.
export const PROTOCOL = 2;
export const spots = [
  "Desk",
  "Table",
  "Window sill",
  "Chair",
  "Shelf",
  "Floor / carpet",
  "Box / crate",
  "Near plants",
  "In hand",
  "Other",
];
export const tagOptions = {
  facing: [
    ["front", "Front label"],
    ["side", "Side"],
    ["back", "Back label"],
  ],
  camHeight: [
    ["low", "Low"],
    ["eye", "Bottle height"],
    ["high", "From above"],
  ],
  distance: [
    ["near", "Close"],
    ["mid", "Medium"],
    ["far", "Far"],
  ],
};
// A rotating shot plan. Each photo of a fill gets the next prompt, and each fill
// starts at a different point, so every combination appears across the dataset.
export const plan = [
  {
    facing: "front",
    camHeight: "eye",
    distance: "mid",
    text: "Pick a new spot. Front label towards you. Phone at bottle height.",
  },
  {
    facing: "back",
    camHeight: "eye",
    distance: "mid",
    same: true,
    text: "Same spot. Turn the bottle so the back label faces you.",
  },
  {
    facing: "side",
    camHeight: "high",
    distance: "mid",
    text: "New spot. Side view. Hold the phone a little above and look down.",
  },
  {
    facing: "front",
    camHeight: "low",
    distance: "near",
    text: "New spot. Close up: the bottle fills most of the frame height. Phone low.",
  },
  {
    spot: "In hand",
    facing: "side",
    camHeight: "eye",
    distance: "mid",
    text: "Hold the bottle upright in your hand. Keep the water still.",
  },
  {
    facing: "back",
    camHeight: "eye",
    distance: "far",
    text: "New spot, ideally by a window. Step back: bottle about 40% of the frame height.",
  },
  {
    facing: "side",
    camHeight: "high",
    distance: "far",
    text: "New spot. Phone high, looking down steeply. Whole bottle visible.",
  },
  {
    facing: "front",
    camHeight: "eye",
    distance: "near",
    text: "New spot. Turn the bottle a quarter turn, then shoot from slightly off centre.",
  },
];
export const planFor = (fill, photo) => plan[(photo + fill * 3) % plan.length];
// Ten equal bins from empty to the full reference, for coverage.
export const BINS = 10;
export function binOf(massG, reference) {
  if (!(reference > 0)) return 0;
  return Math.max(
    0,
    Math.min(BINS - 1, Math.floor((massG / reference) * BINS)),
  );
}
export function coverage(fills, reference) {
  const c = Array(BINS).fill(0);
  for (const f of fills) c[binOf(f.mass, reference)]++;
  return c;
}
// Suggest the next pour. Choose the least-covered tenth of the range (ties at
// random), then a random amount inside it, so masses are spread evenly and are
// never stuck on round 10% steps. The real balance reading is the label.
export function suggestTarget(reference, fills, rand = Math.random) {
  const c = coverage(fills, reference),
    low = Math.min(...c),
    choices = c.map((n, i) => (n === low ? i : -1)).filter((i) => i >= 0),
    bin = choices[Math.floor(rand() * choices.length)];
  if (bin === 0 && rand() < 0.3) return 0;
  const g = ((bin + rand()) / BINS) * reference;
  return Math.max(0, Math.round(g / 5) * 5);
}
export const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
export const mass = (s) => {
  if (String(s).trim() === "") throw Error("Enter the balance reading.");
  const n = Number(String(s).replace(",", "."));
  if (!Number.isFinite(n) || n < 0)
    throw Error("Enter a valid mass in grams, for example 224.7.");
  return n;
};
export const grams = (n) =>
  Number(n).toLocaleString(undefined, { maximumFractionDigits: 3 });
// Photos to take of each fill. More are allowed.
export const countShots = (r) =>
  r.protocol === PROTOCOL
    ? r.split === "train"
      ? 8
      : 4
    : r.split === "train"
      ? 10
      : 5;
// Measured fills to aim for per bottle and split.
export const fillGoal = { train: 60, validation: 12, holdout: 12 };
const pad = (n) => String(n).padStart(2, "0");
const fillTag = (r, l) => (r.protocol === PROTOCOL ? "F" : "L") + pad(l);
const shotTag = (r, s) =>
  r.protocol === PROTOCOL ? "P" + pad(s + 1) : `${shots[s][0]}_${pad(s + 1)}`;
export const token = (s) => {
  if (!/^[A-Za-z0-9_-]{1,24}$/.test(s))
    throw Error("Use 1–24 letters, numbers, underscores or hyphens for IDs.");
  return s;
};
export const photoName = (r, l, s) =>
  `${r.bottle}_${r.instance}_${r.session}_${r.id.slice(0, 8)}_${fillTag(r, l)}_${shotTag(r, s)}.jpg`;
export const photoPath = (r, l, s) =>
  `images/${r.bottle}/${r.instance}/${r.session}_${r.id.slice(0, 8)}/${fillTag(r, l)}/${photoName(r, l, s)}`;
export const fillFolder = fillTag;
export function checkRun(r, runs) {
  token(r.instance);
  token(r.session);
  token(r.setup);
  if (
    !bottles.some((b) => b.id === r.bottle) ||
    !["train", "validation", "holdout"].includes(r.split)
  )
    throw Error("Choose a valid bottle and split.");
  if (r.reference <= 0 || r.resolution <= 0)
    throw Error(
      "Reference water mass and scale step must be greater than zero.",
    );
  if (!String(r.lighting || "").trim()) throw Error("Choose the lighting.");
  if (runs.some((x) => x.setup === r.setup && x.split !== r.split))
    throw Error(
      "This setup ID belongs to another split. Use an independently photographed setup for validation or holdout.",
    );
  if (
    runs.some(
      (x) =>
        x.bottle === r.bottle &&
        x.instance === r.instance &&
        Math.abs(x.reference - r.reference) > r.resolution,
    )
  )
    throw Error(
      "Use the same full-reference water mass for this physical bottle.",
    );
}
export function waterMass(r, level, gross) {
  const n = Math.round((gross - r.tare) * 1e6) / 1e6;
  if (n < 0)
    throw Error("Filled mass cannot be below the empty bottle + cap mass.");
  if (n > r.reference * 1.15)
    throw Error(
      "This is more than 115% of the full reference. Check the balance reading.",
    );
  if (r.protocol !== PROTOCOL && level === 0 && n > r.resolution)
    throw Error("Level 0 should be empty, within one scale step.");
  return n;
}
export function csv(rows) {
  const fields = [
    "filename",
    "relative_path",
    "bottle_id",
    "instance_id",
    "session_id",
    "setup_id",
    "split",
    "level_index",
    "fill_id",
    "target_percent",
    "target_water_g",
    "water_mass_g",
    "gross_mass_g",
    "tare_g",
    "reference_water_g",
    "scale_resolution_g",
    "view",
    "spot",
    "label_facing",
    "camera_height",
    "distance",
    "visibility",
    "background",
    "lighting",
    "width",
    "height",
    "bytes",
    "taken_at",
    "photo_id",
    "protocol",
  ];
  return [
    fields.join(","),
    ...rows.map((r) =>
      fields
        .map((k) => '"' + String(r[k] ?? "").replaceAll('"', '""') + '"')
        .join(","),
    ),
  ].join("\r\n");
}
export function labelFor(p, r) {
  const v2 = r.protocol === PROTOCOL,
    target =
      p.target ?? r.fills?.[p.level]?.target ?? (r.reference * p.level) / 10;
  return {
    filename: p.name,
    relative_path: p.path,
    bottle_id: r.bottle,
    instance_id: r.instance,
    session_id: r.session + "_" + r.id.slice(0, 8),
    setup_id: r.setup,
    split: r.split,
    level_index: p.level,
    fill_id: `${r.bottle}_${r.instance}_${r.session}_${r.id.slice(0, 8)}_${fillTag(r, p.level)}`,
    target_percent: v2
      ? Math.round((target / r.reference) * 1000) / 10
      : p.level * 10,
    target_water_g: target,
    water_mass_g: p.mass,
    gross_mass_g: p.gross,
    // The fill's reading (differs only for a retake labelled with a refill weight).
    fill_gross_mass_g: r.fills?.[p.level]?.gross ?? p.gross,
    fill_water_mass_g: r.fills?.[p.level]?.mass ?? p.mass,
    tare_g: r.tare,
    reference_water_g: r.reference,
    scale_resolution_g: r.resolution,
    view: v2
      ? `${p.facing || ""}/${p.camHeight || ""}/${p.distance || ""}`
      : shots[p.shot]?.[0],
    spot: p.spot || "",
    label_facing: p.facing || "",
    camera_height: p.camHeight || "",
    distance: p.distance || "",
    visibility: p.visibility,
    background: r.background,
    lighting: r.lighting,
    width: p.width,
    height: p.height,
    bytes: p.blob.size,
    taken_at: p.takenAt,
    photo_id: p.id,
    protocol: r.protocol || 1,
  };
}

export function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const a = crypto.getRandomValues(new Uint8Array(16));
  a[6] = (a[6] & 15) | 64;
  a[8] = (a[8] & 63) | 128;
  const h = [...a].map((n) => n.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
