// Parse standard VCD signal declarations and value changes without inventing values.
export function parseVcd(input) {
  const tokens = input.match(/\S+/g) || [];
  const scopes = [];
  const signals = [];
  const identifiers = new Map();
  let time = 0n;
  let timescale = null;
  let inHeader = true;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (inHeader && token === '$scope') { scopes.push(tokens[i + 2]); i += 2; continue; }
    if (inHeader && token === '$upscope') { scopes.pop(); continue; }
    if (inHeader && token === '$timescale') { const parts = []; while (++i < tokens.length && tokens[i] !== '$end') parts.push(tokens[i]); timescale = parts.join(' '); continue; }
    if (inHeader && token === '$var') {
      const type = tokens[++i]; const width = Number(tokens[++i]); const id = tokens[++i];
      const name = tokens[++i];
      if (!type || !Number.isInteger(width) || width < 1 || !id || !name) throw new Error('Invalid VCD variable declaration');
      const suffix = [];
      while (++i < tokens.length && tokens[i] !== '$end') suffix.push(tokens[i]);
      const signal = { path: [...scopes, name].join('.'), type, width, id, range: suffix.join(' '), changes: [] };
      signals.push(signal); if (!identifiers.has(id)) identifiers.set(id, []); identifiers.get(id).push(signal); continue;
    }
    if (inHeader && token === '$enddefinitions') { inHeader = false; continue; }
    if (inHeader) continue;
    if (token[0] === '#') { if (!/^#\d+$/.test(token)) throw new Error('Invalid VCD timestamp'); time = BigInt(token.slice(1)); continue; }
    let id; let value;
    if (/^[01xXzZ]/.test(token)) { value = token[0].toLowerCase(); id = token.slice(1); }
    else if (/^[bB][01xXzZ]+$/.test(token)) { value = token.slice(1).toLowerCase(); id = tokens[++i]; }
    else continue;
    for (const signal of identifiers.get(id) || []) signal.changes.push({ time, value });
  }
  if (inHeader) throw new Error('VCD header is incomplete');
  return { timescale, signals, endTime: time };
}

export function valueAt(signal, time) {
  let low = 0; let high = signal.changes.length;
  while (low < high) { const mid = (low + high) >>> 1; if (signal.changes[mid].time <= time) low = mid + 1; else high = mid; }
  return low ? signal.changes[low - 1].value : null;
}
