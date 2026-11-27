export function parseSliceSpec(spec) {
  const m = /^\s*([A-Za-z_$][\w$.]*)\s*\[\s*(\d+)\s*(?::\s*(\d+)\s*)?\]\s*$/.exec(spec);
  if (!m) return null;
  const msb = Number(m[2]), lsb = Number(m[3] ?? m[2]);
  if (!Number.isSafeInteger(msb) || !Number.isSafeInteger(lsb) || msb < lsb) return null;
  return { signal: m[1], msb, lsb };
}
export function sliceBits(value, width, msb, lsb) {
  if (!Number.isInteger(width) || width < 1 || !Number.isInteger(msb) || !Number.isInteger(lsb) || lsb < 0 || msb < lsb || msb >= width || typeof value !== 'string' || !/^[01xz]+$/i.test(value) || value.length > width) throw new RangeError('Invalid bit slice');
  const bits = value.toLowerCase().padStart(width, /^[xz]/i.test(value) ? value[0].toLowerCase() : '0');
  return bits.slice(width - 1 - msb, width - lsb);
}
