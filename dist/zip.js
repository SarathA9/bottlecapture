const table = Array.from({ length: 256 }, (_, i) => {
  for (let j = 0; j < 8; j++) i = i & 1 ? 0xedb88320 ^ (i >>> 1) : i >>> 1;
  return i >>> 0;
});
export function crc32(a) {
  let c = 0xffffffff;
  for (const b of a) c = table[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
export async function zip(files) {
  let offset = 0;
  const parts = [],
    central = [];
  if (files.length > 65000) throw Error("Export fewer files at once.");
  for (const [name, blob] of files) {
    const bytes = new Uint8Array(await blob.arrayBuffer()),
      n = new TextEncoder().encode(name),
      crc = crc32(bytes);
    if (offset + bytes.length > 0xffffffff)
      throw Error("Export one session at a time (ZIP limit 4 GB).");
    const h = new Uint8Array(30),
      v = new DataView(h.buffer);
    v.setUint32(0, 0x04034b50, true);
    v.setUint16(4, 20, true);
    v.setUint16(6, 0x800, true);
    v.setUint32(14, crc, true);
    v.setUint32(18, bytes.length, true);
    v.setUint32(22, bytes.length, true);
    v.setUint16(26, n.length, true);
    parts.push(h, n, blob);
    const c = new Uint8Array(46),
      w = new DataView(c.buffer);
    w.setUint32(0, 0x02014b50, true);
    w.setUint16(4, 20, true);
    w.setUint16(6, 20, true);
    w.setUint16(8, 0x800, true);
    w.setUint32(16, crc, true);
    w.setUint32(20, bytes.length, true);
    w.setUint32(24, bytes.length, true);
    w.setUint16(28, n.length, true);
    w.setUint32(42, offset, true);
    central.push(c, n);
    offset += 30 + n.length + bytes.length;
  }
  const size = central.reduce((s, a) => s + a.length, 0),
    e = new Uint8Array(22),
    v = new DataView(e.buffer);
  v.setUint32(0, 0x06054b50, true);
  v.setUint16(8, files.length, true);
  v.setUint16(10, files.length, true);
  v.setUint32(12, size, true);
  v.setUint32(16, offset, true);
  return new Blob([...parts, ...central, e], { type: "application/zip" });
}
