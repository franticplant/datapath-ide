import { zipSync, unzipSync, strToU8 } from './vendor/zip.js';

const MAX_ARCHIVE = 32 * 1024 * 1024;
const META = '.datapath-studio.json';
export function validPath(path) {
  return typeof path === 'string' && path.length > 0 && !path.startsWith('/') && !path.includes('\\') && !/[\0\r\n]/.test(path) && path.split('/').every(part => part && part !== '.' && part !== '..');
}
export function createArchive(files, folders, excluded, vcd) {
  if (Object.hasOwn(files, META)) throw new Error(`Rename ${META} before exporting; that name is reserved for project settings.`);
  const entries = Object.create(null);
  for (const [path, text] of Object.entries(files)) { if (!validPath(path)) throw new Error(`Invalid file path: ${path}`); entries[path] = strToU8(text); }
  for (const path of folders) { if (!validPath(path)) throw new Error(`Invalid folder path: ${path}`); entries[`${path}/`] = new Uint8Array(); }
  if (vcd) { let path = '.simulation/latest.vcd'; let n = 1; while (Object.hasOwn(entries, path)) path = `.simulation/latest-${n++}.vcd`; entries[path] = strToU8(vcd); }
  entries[META] = strToU8(JSON.stringify({ version: 1, excluded: [...excluded], folders: [...folders] }));
  return zipSync(entries, { level: 6 });
}
export function readArchive(data) {
  if (data.byteLength > MAX_ARCHIVE) throw new Error('Archive exceeds 32 MB.');
  const bytes = new Uint8Array(data); const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) if (view.getUint32(i, true) === 0x06054b50 && i + 22 + view.getUint16(i + 20, true) === bytes.length) { eocd = i; break; }
  if (eocd < 0) throw new Error('Invalid ZIP archive.');
  const count = view.getUint16(eocd + 10, true); const offset = view.getUint32(eocd + 16, true); const size = view.getUint32(eocd + 12, true);
  if (view.getUint16(eocd + 4, true) || view.getUint16(eocd + 6, true) || count === 0xffff || offset === 0xffffffff || count > 5000 || offset + size > eocd) throw new Error('Unsupported or oversized ZIP archive.');
  let cursor = offset; let total = 0; const names = new Set(); const decoder = new TextDecoder('utf-8', { fatal: true });
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > bytes.length || view.getUint32(cursor, true) !== 0x02014b50) throw new Error('Invalid ZIP directory.');
    const flags = view.getUint16(cursor + 8, true); const uncompressed = view.getUint32(cursor + 24, true); const nameLength = view.getUint16(cursor + 28, true); const extra = view.getUint16(cursor + 30, true); const comment = view.getUint16(cursor + 32, true);
    if ((flags & 1) || uncompressed === 0xffffffff || (total += uncompressed) > MAX_ARCHIVE || cursor + 46 + nameLength + extra + comment > offset + size) throw new Error('Encrypted, oversized or invalid ZIP archive.');
    const name = decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength)); const path = name.endsWith('/') ? name.slice(0, -1) : name;
    if (!validPath(path) || names.has(name)) throw new Error(`Invalid or duplicate archive path: ${name}`);
    names.add(name);
    cursor += 46 + nameLength + extra + comment;
    if (cursor > offset + size) throw new Error('Invalid ZIP directory.');
  }
  if (cursor !== offset + size) throw new Error('Invalid ZIP directory size.');
  const raw = unzipSync(bytes); const files = Object.create(null); const folders = []; let metadata = null;
  for (const [path, content] of Object.entries(raw)) {
    const folder = path.endsWith('/'); const normalized = folder ? path.slice(0, -1) : path;
    if (!validPath(normalized)) throw new Error(`Invalid archive path: ${path}`);
    if (folder) { folders.push(normalized); continue; }
    const text = decoder.decode(content);
    if (normalized === META) { metadata = JSON.parse(text); continue; }
    files[normalized] = text;
  }
  return { files, folders, excluded: Array.isArray(metadata?.excluded) ? metadata.excluded.filter(path => typeof path === 'string') : [] };
}
