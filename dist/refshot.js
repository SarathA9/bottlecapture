// Reference picture for one shot, drawn in code (no photos).
// Left: side view with the spot, the bottle and where to hold the phone.
// Right: the bottle seen from above, showing which label side faces the phone.
const C = {
  ink: "#1f3b30",
  line: "#9fb39a",
  soft: "#e6eedc",
  wood: "#c9b48f",
  woodDark: "#a8936d",
  wall: "#f4f6ef",
  bottle: "#d7e7e4",
  bottleEdge: "#7f9c95",
  label: "#ffffff",
  labelEdge: "#7c9870",
  phone: "#315c46",
  sight: "#5d8a6f",
};

// Height of the surface the bottle stands on, per spot.
const SURFACE = {
  Table: 140,
  "Floor / carpet": 168,
  Shelf: 118,
  "Window sill": 136,
  Chair: 132,
  "In hand": 142,
};
const surf = (spot) => SURFACE[spot] ?? 140;
const BX = 220; // bottle centre in the side view

function scene(spot) {
  const s = surf(spot);
  switch (spot) {
    case "Table":
      return `<rect x="118" y="${s}" width="196" height="8" rx="2" fill="${C.wood}"/><rect x="134" y="${s + 8}" width="6" height="${186 - s - 8}" fill="${C.woodDark}"/><rect x="292" y="${s + 8}" width="6" height="${186 - s - 8}" fill="${C.woodDark}"/>`;
    case "Floor / carpet":
      return `<rect x="0" y="${s}" width="320" height="${190 - s}" fill="${C.soft}"/>${Array.from({ length: 14 }, (_, i) => `<path d="M${8 + i * 23} ${s + 9}h12" stroke="${C.line}" stroke-width="1.5" stroke-linecap="round"/>`).join("")}`;
    case "Shelf":
      return `<rect x="120" y="0" width="200" height="${s}" fill="${C.wall}"/><rect x="128" y="${s}" width="190" height="7" rx="1.5" fill="${C.wood}"/><path d="M150 ${s + 7}v26l26 -26z M290 ${s + 7}v26l-26 -26z" fill="${C.woodDark}"/>`;
    case "Window sill":
      return `<rect x="150" y="14" width="140" height="${s - 18}" fill="#eaf3f7" stroke="${C.line}" stroke-width="3"/><path d="M220 14v${s - 18} M150 ${(14 + s - 4) / 2}h140" stroke="${C.line}" stroke-width="3"/><rect x="138" y="${s}" width="166" height="8" rx="2" fill="${C.wood}"/><rect x="138" y="${s + 8}" width="166" height="${190 - s - 8}" fill="${C.wall}"/>`;
    case "Chair":
      return `<rect x="176" y="${s}" width="96" height="8" rx="2" fill="${C.wood}"/><rect x="266" y="54" width="8" height="${s - 54}" rx="2" fill="${C.woodDark}"/><rect x="182" y="${s + 8}" width="6" height="${186 - s - 8}" fill="${C.woodDark}"/><rect x="262" y="${s + 8}" width="6" height="${186 - s - 8}" fill="${C.woodDark}"/>`;
    case "In hand":
      // A hand holding the lower part of the bottle, arm going down and to the right.
      return `<path d="M${BX + 16} ${s - 30} q26 4 40 36 l26 58 h-36 l-18 -44 q-6 -10 -14 -8z" fill="#e8c9ad" stroke="#c49f80" stroke-width="1.5"/><path d="M${BX - 20} ${s - 36} q-4 18 6 32 q16 8 34 2 q8 -16 0 -34 q-20 -6 -40 0z" fill="#e8c9ad" stroke="#c49f80" stroke-width="1.5"/><path d="M${BX - 16} ${s - 26}h32 M${BX - 15} ${s - 17}h30" stroke="#c49f80" stroke-width="1.2"/>`;
    default:
      return `<rect x="110" y="${s}" width="210" height="7" rx="2" fill="${C.wood}"/>`;
  }
}

// Bottle standing on the surface. The label shows which side faces the camera.
function bottle(spot, facing) {
  const base = surf(spot),
    top = base - 92,
    w = 34,
    x = BX - w / 2;
  const body = `<path d="M${BX - 7} ${top + 10}h14v14c0 6 10 9 10 18v${base - top - 46}q0 4 -4 4h-26q-4 0 -4 -4v-${base - top - 46}c0 -9 10 -12 10 -18z" fill="${C.bottle}" stroke="${C.bottleEdge}" stroke-width="1.6"/><rect x="${BX - 8}" y="${top}" width="16" height="11" rx="2.5" fill="${C.phone}"/>`;
  const ly = top + 48,
    lh = 22;
  let label = "";
  if (facing === "front")
    label = `<rect x="${x}" y="${ly}" width="${w}" height="${lh}" fill="${C.label}" stroke="${C.labelEdge}" stroke-width="1.2"/><text x="${BX}" y="${ly + 14}" text-anchor="middle" font-size="7.5" font-weight="700" fill="${C.ink}" font-family="system-ui,sans-serif">LABEL</text>`;
  else if (facing === "back")
    label = `<rect x="${x}" y="${ly}" width="${w}" height="${lh}" fill="${C.label}" stroke="${C.labelEdge}" stroke-width="1.2"/>${[3, 6, 8, 11, 14, 16, 19, 22, 24, 27].map((dx) => `<path d="M${x + 3 + dx} ${ly + 5}v12" stroke="${C.ink}" stroke-width="${dx % 2 ? 1.6 : 0.8}"/>`).join("")}`;
  else
    label = `<rect x="${x + w - 9}" y="${ly}" width="9" height="${lh}" fill="${C.label}" stroke="${C.labelEdge}" stroke-width="1.2"/>`;
  return body + label;
}

// Where the phone is: further left = further away, higher = from above.
function phonePos(spot, camHeight, distance) {
  const s = surf(spot),
    mid = s - 46,
    dx = { near: 62, mid: 116, far: 172 }[distance],
    y = { low: s - 14, eye: mid, high: Math.max(26, s - 118) }[camHeight];
  return { x: BX - dx, y, tx: BX, ty: mid };
}

function phone(spot, camHeight, distance) {
  const p = phonePos(spot, camHeight, distance),
    angle = (Math.atan2(p.ty - p.y, p.tx - p.x) * 180) / Math.PI;
  return `<path d="M${p.x} ${p.y}L${p.tx - 20} ${p.ty}" stroke="${C.sight}" stroke-width="1.6" stroke-dasharray="5 4"/><g transform="translate(${p.x} ${p.y}) rotate(${angle.toFixed(1)})"><rect x="-6" y="-13" width="12" height="26" rx="3" fill="${C.phone}"/><circle cx="4" cy="-8" r="2.2" fill="#e6eed8"/><path d="M6 -6l10 -6v24l-10 -6" fill="${C.sight}" opacity=".35"/></g>`;
}

// Seen from above: bottle circle, thick arc = where the label is, phone below.
function topView(facing, distance) {
  const cx = 368,
    cy = 44,
    r = 14,
    camY = { near: 84, mid: 100, far: 116 }[distance],
    arc = {
      front: [150, 30],
      back: [-30, -150],
      side: [-60, 60],
    }[facing],
    pt = (deg) => [
      cx + r * Math.cos((deg * Math.PI) / 180),
      cy + r * Math.sin((deg * Math.PI) / 180),
    ],
    [a1, a2] = [pt(arc[0]), pt(arc[1])];
  return `<rect x="326" y="4" width="86" height="182" rx="10" fill="${C.wall}" stroke="${C.soft}"/><text x="369" y="20" text-anchor="middle" font-size="9" fill="#6e8268" font-family="system-ui,sans-serif">from above</text><circle cx="${cx}" cy="${cy}" r="${r}" fill="${C.bottle}" stroke="${C.bottleEdge}" stroke-width="1.6"/><path d="M${a1[0].toFixed(1)} ${a1[1].toFixed(1)}A${r} ${r} 0 0 0 ${a2[0].toFixed(1)} ${a2[1].toFixed(1)}" fill="none" stroke="${C.labelEdge}" stroke-width="5" stroke-linecap="round"/><path d="M${cx} ${camY - 12}V${cy + r + 4}" stroke="${C.sight}" stroke-width="1.6" stroke-dasharray="4 3"/><rect x="${cx - 12}" y="${camY - 6}" width="24" height="12" rx="3" fill="${C.phone}"/><text x="369" y="${Math.min(camY + 20, 152)}" text-anchor="middle" font-size="8" fill="#6e8268" font-family="system-ui,sans-serif">phone</text><text x="369" y="166" text-anchor="middle" font-size="8.5" fill="${C.ink}" font-family="system-ui,sans-serif">label: ${facing}</text>`;
}

export function referenceSvg(c, caption = "") {
  return `<svg class="ref-svg" viewBox="0 0 420 190" role="img" aria-label="${caption.replace(/"/g, "")}"><rect x="0" y="0" width="320" height="190" rx="10" fill="#fbfcf8"/>${scene(c.spot)}${bottle(c.spot, c.facing)}${phone(c.spot, c.camHeight, c.distance)}${topView(c.facing, c.distance)}</svg>`;
}
