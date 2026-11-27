// MIPS32 (MIPS-I subset) assembler producing $readmemh-compatible .mem text. No dependencies beyond the decoder.
import { MIPS_REGISTERS, decodeMips } from './mips-decode.js';

const REGISTER_NUMBERS = new Map(MIPS_REGISTERS.map((name, index) => [name, index]));
REGISTER_NUMBERS.set('$s8', 30);
for (let index = 0; index < 32; index++) REGISTER_NUMBERS.set(`$${index}`, index);

const R3 = { add: 0x20, addu: 0x21, sub: 0x22, subu: 0x23, and: 0x24, or: 0x25, xor: 0x26, nor: 0x27, slt: 0x2a, sltu: 0x2b };
const SHIFT = { sll: 0x00, srl: 0x02, sra: 0x03 };
const SHIFT_V = { sllv: 0x04, srlv: 0x06, srav: 0x07 };
const MULDIV = { mult: 0x18, multu: 0x19, div: 0x1a, divu: 0x1b };
const MOVE_FROM = { mfhi: 0x10, mflo: 0x12 };
const ARITH_I = { addi: 0x08, addiu: 0x09, slti: 0x0a, sltiu: 0x0b };
const LOGIC_I = { andi: 0x0c, ori: 0x0d, xori: 0x0e };
const MEMORY = { lb: 0x20, lh: 0x21, lw: 0x23, lbu: 0x24, lhu: 0x25, sb: 0x28, sh: 0x29, sw: 0x2b };
const BRANCH = { beq: 0x04, bne: 0x05 };
const JUMP = { j: 0x02, jal: 0x03 };
const BRANCH_PSEUDO = { blt: ['slt', false, 'bne'], bgt: ['slt', true, 'bne'], ble: ['slt', true, 'beq'], bge: ['slt', false, 'beq'] };

export const MIPS_MNEMONICS = [
  ...Object.keys(R3), ...Object.keys(SHIFT), ...Object.keys(SHIFT_V), ...Object.keys(MULDIV), ...Object.keys(MOVE_FROM),
  'jr', 'jalr', 'syscall', ...Object.keys(ARITH_I), ...Object.keys(LOGIC_I), 'lui', ...Object.keys(MEMORY),
  ...Object.keys(BRANCH), ...Object.keys(JUMP),
  'nop', 'move', 'li', 'la', 'subi', 'not', 'neg', 'b', 'beqz', 'bnez', ...Object.keys(BRANCH_PSEUDO),
];
export const MIPS_DIRECTIVES = ['.text', '.data', '.word', '.globl', '.global', '.org', '.base'];

class AsmError extends Error {}
const fail = message => { throw new AsmError(message); };

const validOutput = path => typeof path === 'string' && /^[^/\\\0]/.test(path) && !path.split('/').some(part => !part || part === '.' || part === '..') && !/[\r\n\\]/.test(path);

// Default output: the source path with .asm/.s replaced by .mem.
export function defaultOutputName(filename) {
  return /\.(?:asm|s)$/i.test(filename) ? filename.replace(/\.(?:asm|s)$/i, '.mem') : `${filename}.mem`;
}

// Strips '#' and '//' comments, leaving character literals such as '#' intact.
function stripComment(line) {
  let quote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "'" ) quote = !quote;
    else if (!quote && (ch === '#' || (ch === '/' && line[i + 1] === '/'))) return line.slice(0, i);
  }
  return line;
}

// Splits operands on top-level commas.
function splitOperands(text) {
  const parts = [];
  let depth = 0, start = 0, quote = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "'") quote = !quote;
    else if (!quote && ch === '(') depth++;
    else if (!quote && ch === ')') depth--;
    else if (!quote && ch === ',' && depth === 0) { parts.push(text.slice(start, i)); start = i + 1; }
  }
  const last = text.slice(start);
  if (last.trim() || parts.length) parts.push(last);
  return parts.map(part => part.trim());
}

function parseNumber(text) {
  const t = text.trim();
  let match;
  if ((match = /^([+-]?)0x([0-9a-f]+)$/i.exec(t))) return (match[1] === '-' ? -1 : 1) * parseInt(match[2], 16);
  if ((match = /^([+-]?)0b([01]+)$/i.exec(t))) return (match[1] === '-' ? -1 : 1) * parseInt(match[2], 2);
  if (/^[+-]?\d+$/.test(t)) return parseInt(t, 10);
  if ((match = /^'(\\?.)'$/.exec(t))) {
    const body = match[1];
    const escapes = { '\\n': 10, '\\t': 9, '\\0': 0, "\\'": 39, '\\\\': 92 };
    return body.length === 2 ? escapes[body] ?? fail(`Unknown escape ${body}`) : body.charCodeAt(0);
  }
  return null;
}

const IDENT = /^[A-Za-z_.$][\w.$]*$/;

// number | label | label+number | label-number
function evaluate(text, labels, { allowLabels = true } = {}) {
  const t = text.trim();
  if (!t) fail('Missing operand');
  const number = parseNumber(t);
  if (number !== null) return number;
  const match = /^([A-Za-z_.$][\w.$]*)\s*(?:([+-])\s*(.+))?$/.exec(t);
  if (!match || !allowLabels) fail(`Invalid number '${t}'`);
  if (labels === null) return 0;   // pass 1: value not needed yet
  if (!labels.has(match[1])) fail(`Undefined label '${match[1]}'`);
  const offset = match[3] === undefined ? 0 : parseNumber(match[3]);
  if (offset === null) fail(`Invalid offset '${match[3]}'`);
  return labels.get(match[1]) + (match[2] === '-' ? -offset : offset);
}

function register(text) {
  const name = text.trim().toLowerCase();
  if (!REGISTER_NUMBERS.has(name)) fail(`Unknown register '${text.trim()}'`);
  return REGISTER_NUMBERS.get(name);
}

const inRange = (value, low, high, what) => {
  if (!Number.isInteger(value) || value < low || value > high) fail(`${what} ${value} is out of range [${low}, ${high}]`);
  return value;
};
const signed16 = (value, what = 'Immediate') => inRange(value, -32768, 32767, what) & 0xffff;
const unsigned16 = (value, what = 'Immediate') => inRange(value, 0, 65535, what);

const rType = (rs, rt, rd, shamt, funct) => ((rs << 21) | (rt << 16) | (rd << 11) | (shamt << 6) | funct) >>> 0;
const iType = (op, rs, rt, imm) => ((op << 26) | (rs << 21) | (rt << 16) | (imm & 0xffff)) >>> 0;
const jType = (op, target) => ((op << 26) | (target & 0x3ffffff)) >>> 0;

function expectCount(operands, count, usage) {
  if (operands.length !== count) fail(`Expected ${usage}`);
}

// How many words li emits for a constant (must match pass 2 exactly).
function liWords(value) {
  inRange(value, -2147483648, 4294967295, 'Immediate');
  if (value >= -32768 && value <= 65535) return 1;
  return (value & 0xffff) === 0 ? 1 : 2;
}

// Words a statement occupies; label values are not needed (pass 1).
function sizeOf(mnemonic, operands) {
  if (mnemonic === 'li') {
    expectCount(operands, 2, 'li $rt, imm');
    const value = parseNumber(operands[1]);
    if (value === null) fail(`li needs a numeric constant (use la for labels)`);
    return liWords(value);
  }
  if (mnemonic === 'la' || Object.hasOwn(BRANCH_PSEUDO, mnemonic)) return 2;
  return 1;
}

// Encodes one statement at `pc`; returns the words (pass 2).
function encode(mnemonic, operands, pc, labels) {
  const branchOffset = (text, from) => {
    const target = evaluate(text, labels);
    if ((target & 3) !== 0) fail(`Branch target 0x${(target >>> 0).toString(16)} is not word aligned`);
    return signed16((target - (from + 4)) / 4, 'Branch offset');
  };
  if (Object.hasOwn(R3, mnemonic)) {
    expectCount(operands, 3, `${mnemonic} $rd, $rs, $rt`);
    return [rType(register(operands[1]), register(operands[2]), register(operands[0]), 0, R3[mnemonic])];
  }
  if (Object.hasOwn(SHIFT, mnemonic)) {
    expectCount(operands, 3, `${mnemonic} $rd, $rt, shamt`);
    return [rType(0, register(operands[1]), register(operands[0]), inRange(evaluate(operands[2], labels, { allowLabels: false }), 0, 31, 'Shift amount'), SHIFT[mnemonic])];
  }
  if (Object.hasOwn(SHIFT_V, mnemonic)) {
    expectCount(operands, 3, `${mnemonic} $rd, $rt, $rs`);
    return [rType(register(operands[2]), register(operands[1]), register(operands[0]), 0, SHIFT_V[mnemonic])];
  }
  if (Object.hasOwn(MULDIV, mnemonic)) {
    expectCount(operands, 2, `${mnemonic} $rs, $rt`);
    return [rType(register(operands[0]), register(operands[1]), 0, 0, MULDIV[mnemonic])];
  }
  if (Object.hasOwn(MOVE_FROM, mnemonic)) {
    expectCount(operands, 1, `${mnemonic} $rd`);
    return [rType(0, 0, register(operands[0]), 0, MOVE_FROM[mnemonic])];
  }
  if (mnemonic === 'jr') { expectCount(operands, 1, 'jr $rs'); return [rType(register(operands[0]), 0, 0, 0, 0x08)]; }
  if (mnemonic === 'jalr') {
    if (operands.length === 1) return [rType(register(operands[0]), 0, 31, 0, 0x09)];
    expectCount(operands, 2, 'jalr [$rd,] $rs');
    return [rType(register(operands[1]), 0, register(operands[0]), 0, 0x09)];
  }
  if (mnemonic === 'syscall') { expectCount(operands, 0, 'syscall'); return [0x0000000c]; }
  if (Object.hasOwn(ARITH_I, mnemonic)) {
    expectCount(operands, 3, `${mnemonic} $rt, $rs, imm`);
    return [iType(ARITH_I[mnemonic], register(operands[1]), register(operands[0]), signed16(evaluate(operands[2], labels)))];
  }
  if (Object.hasOwn(LOGIC_I, mnemonic)) {
    expectCount(operands, 3, `${mnemonic} $rt, $rs, imm`);
    return [iType(LOGIC_I[mnemonic], register(operands[1]), register(operands[0]), unsigned16(evaluate(operands[2], labels)))];
  }
  if (mnemonic === 'lui') {
    expectCount(operands, 2, 'lui $rt, imm');
    return [iType(0x0f, 0, register(operands[0]), unsigned16(evaluate(operands[1], labels)))];
  }
  if (Object.hasOwn(MEMORY, mnemonic)) {
    expectCount(operands, 2, `${mnemonic} $rt, offset($rs)`);
    const match = /^(.*?)\(\s*(\$[\w]+)\s*\)$/.exec(operands[1]);
    if (!match) fail(`Expected offset($rs), got '${operands[1]}'`);
    const offset = match[1].trim() ? evaluate(match[1], labels) : 0;
    return [iType(MEMORY[mnemonic], register(match[2]), register(operands[0]), signed16(offset, 'Offset'))];
  }
  if (Object.hasOwn(BRANCH, mnemonic)) {
    expectCount(operands, 3, `${mnemonic} $rs, $rt, label`);
    return [iType(BRANCH[mnemonic], register(operands[0]), register(operands[1]), branchOffset(operands[2], pc))];
  }
  if (Object.hasOwn(JUMP, mnemonic)) {
    expectCount(operands, 1, `${mnemonic} target`);
    const target = evaluate(operands[0], labels) >>> 0;
    if ((target & 3) !== 0) fail(`Jump target 0x${target.toString(16)} is not word aligned`);
    if ((target & 0xf0000000) !== ((pc + 4) & 0xf0000000)) fail(`Jump target 0x${target.toString(16)} is outside the current 256 MB region`);
    return [jType(JUMP[mnemonic], target >>> 2)];
  }
  // Pseudo-instructions.
  if (mnemonic === 'nop') { expectCount(operands, 0, 'nop'); return [0]; }
  if (mnemonic === 'move') { expectCount(operands, 2, 'move $rd, $rs'); return [rType(register(operands[1]), 0, register(operands[0]), 0, R3.addu)]; }
  if (mnemonic === 'not') { expectCount(operands, 2, 'not $rd, $rs'); return [rType(register(operands[1]), 0, register(operands[0]), 0, R3.nor)]; }
  if (mnemonic === 'neg') { expectCount(operands, 2, 'neg $rd, $rs'); return [rType(0, register(operands[1]), register(operands[0]), 0, R3.sub)]; }
  if (mnemonic === 'subi') {
    expectCount(operands, 3, 'subi $rt, $rs, imm');
    return [iType(ARITH_I.addi, register(operands[1]), register(operands[0]), signed16(-evaluate(operands[2], labels)))];
  }
  if (mnemonic === 'li') {
    const rt = register(operands[0]);
    const value = parseNumber(operands[1]);
    if (value >= -32768 && value <= 32767) return [iType(ARITH_I.addiu, 0, rt, value)];
    if (value >= 0 && value <= 65535) return [iType(LOGIC_I.ori, 0, rt, value)];
    const word = value >>> 0;
    const lui = iType(0x0f, 0, rt, word >>> 16);
    return (word & 0xffff) === 0 ? [lui] : [lui, iType(LOGIC_I.ori, rt, rt, word & 0xffff)];
  }
  if (mnemonic === 'la') {
    expectCount(operands, 2, 'la $rt, label');
    const rt = register(operands[0]);
    const address = evaluate(operands[1], labels) >>> 0;
    return [iType(0x0f, 0, rt, address >>> 16), iType(LOGIC_I.ori, rt, rt, address & 0xffff)];
  }
  if (mnemonic === 'b') { expectCount(operands, 1, 'b label'); return [iType(BRANCH.beq, 0, 0, branchOffset(operands[0], pc))]; }
  if (mnemonic === 'beqz' || mnemonic === 'bnez') {
    expectCount(operands, 2, `${mnemonic} $rs, label`);
    return [iType(BRANCH[mnemonic === 'beqz' ? 'beq' : 'bne'], register(operands[0]), 0, branchOffset(operands[1], pc))];
  }
  if (Object.hasOwn(BRANCH_PSEUDO, mnemonic)) {
    expectCount(operands, 3, `${mnemonic} $rs, $rt, label`);
    const [, swap, branch] = BRANCH_PSEUDO[mnemonic];
    const rs = register(operands[0]), rt = register(operands[1]);
    const slt = rType(swap ? rt : rs, swap ? rs : rt, 1, 0, R3.slt);
    // The branch is the second word: its offset is relative to its own PC + 4.
    return [slt, iType(BRANCH[branch], 1, 0, branchOffset(operands[2], pc + 4))];
  }
  fail(`Unknown instruction '${mnemonic}'`);
}

/*
 * Assembles MIPS32 source. Returns { ok, words, memText, outputName, listing, labels, diagnostics, baseAddress }.
 * .text starts at baseAddress (default 0, matching a $readmemh-loaded instruction memory with PC = 0);
 * .data follows the text image unless given an explicit address (.data 0x100).
 */
export function assembleMips(source, { filename = 'program.asm', baseAddress = 0 } = {}) {
  const diagnostics = [];
  const error = (line, message) => diagnostics.push({ file: filename, line, severity: 'error', message });
  const lines = String(source).replace(/\r\n?/g, '\n').split('\n');
  let outputName = defaultOutputName(filename);

  // ---- parse
  const statements = [];   // { line, text, labels[], mnemonic, operands, section }
  let section = 'text';
  for (let index = 0; index < lines.length; index++) {
    const lineNo = index + 1;
    const raw = lines[index];
    const pragma = /^\s*(?:#|\/\/)\s*@out\s+(\S+)/.exec(raw);
    if (pragma) {
      if (validOutput(pragma[1]) && /\.(?:mem|hex|txt)$/i.test(pragma[1])) outputName = pragma[1];
      else error(lineNo, `Invalid @out path '${pragma[1]}' (use a relative .mem path)`);
      continue;
    }
    let text = stripComment(raw).trim();
    const labels = [];
    let match;
    while ((match = /^([A-Za-z_.$][\w.$]*)\s*:\s*/.exec(text))) {
      labels.push(match[1]);
      text = text.slice(match[0].length);
    }
    if (!text) { if (labels.length) statements.push({ line: lineNo, text: '', labels, mnemonic: null, operands: [], section }); continue; }
    const head = /^(\S+)\s*(.*)$/.exec(text);
    const mnemonic = head[1].toLowerCase();
    let operands;
    try { operands = splitOperands(head[2]); } catch (err) { error(lineNo, err.message); continue; }
    if (mnemonic === '.text' || mnemonic === '.data') {
      section = mnemonic.slice(1);
      statements.push({ line: lineNo, text, labels, mnemonic, operands, section });
      continue;
    }
    statements.push({ line: lineNo, text, labels, mnemonic, operands, section });
  }

  // ---- pass 1: addresses and labels
  const labels = new Map();
  const counters = { text: baseAddress >>> 0, data: null };
  let dataExplicit = false;
  for (const statement of statements) {
    try {
      if (statement.mnemonic === '.data' && statement.operands.length) {
        counters.data = evaluate(statement.operands[0], null, { allowLabels: false }) >>> 0;
        dataExplicit = true;
      }
      if (statement.section === 'data' && counters.data === null) counters.data = 0;   // placed after .text below
      const counter = statement.section;
      statement.address = counters[counter];
      for (const label of statement.labels) {
        if (labels.has(label)) error(statement.line, `Duplicate label '${label}'`);
        else labels.set(label, { section: counter, offset: counters[counter] });
      }
      const m = statement.mnemonic;
      if (!m || m === '.text' || m === '.data' || m === '.globl' || m === '.global') { statement.size = 0; continue; }
      if (m === '.org' || m === '.base') {
        expectCount(statement.operands, 1, `${m} address`);
        const address = evaluate(statement.operands[0], null, { allowLabels: false }) >>> 0;
        if ((address & 3) !== 0) fail(`${m} address must be word aligned`);
        if (address < counters[counter]) fail(`${m} 0x${address.toString(16)} moves backwards`);
        counters[counter] = address;
        statement.size = 0;
        statement.address = address;
        continue;
      }
      if (m === '.word') {
        if (!statement.operands.length) fail('.word needs at least one value');
        statement.size = statement.operands.length;
      } else if (m.startsWith('.')) {
        fail(`Unknown directive '${statement.mnemonic}'`);
      } else {
        if (counter === 'data') fail('Instructions belong in .text');
        statement.size = sizeOf(m, statement.operands);
      }
      counters[counter] += statement.size * 4;
    } catch (err) {
      if (!(err instanceof AsmError)) throw err;
      error(statement.line, err.message);
      statement.size = 0;
    }
  }
  // .data without an explicit address follows the text image.
  const dataBase = dataExplicit ? 0 : counters.text;
  const absolute = new Map([...labels].map(([name, place]) => [name, (place.section === 'data' && !dataExplicit ? dataBase + place.offset : place.offset) >>> 0]));
  if (!dataExplicit) for (const statement of statements) if (statement.section === 'data') statement.address = (dataBase + statement.address) >>> 0;

  // ---- pass 2: encode
  const image = new Map();   // address -> { word, line, text }
  const listing = [];
  for (const statement of statements) {
    if (!statement.size) continue;
    try {
      let words;
      if (statement.mnemonic === '.word') words = statement.operands.map(operand => evaluate(operand, absolute) >>> 0);
      else words = encode(statement.mnemonic, statement.operands, statement.address, absolute);
      if (words.length !== statement.size) fail(`Internal size mismatch for '${statement.text}'`);
      words.forEach((word, index) => {
        const addr = (statement.address + index * 4) >>> 0;
        if (image.has(addr)) fail(`Address 0x${addr.toString(16)} is assembled twice`);
        const text = index === 0 ? statement.text : `  ${statement.mnemonic === '.word' ? '.word' : decodeMips(word)?.asm || ''}`;
        image.set(addr, { word: word >>> 0, line: statement.line, text });
        listing.push({ addr, word: word >>> 0, hex: (word >>> 0).toString(16).padStart(8, '0'), line: statement.line, text });
      });
    } catch (err) {
      if (!(err instanceof AsmError)) throw err;
      error(statement.line, err.message);
    }
  }
  listing.sort((a, b) => a.addr - b.addr);

  // ---- image -> words / .mem text (gaps from .org are zero-filled)
  const base = baseAddress >>> 0;
  let end = listing.length ? Math.max(...listing.map(entry => entry.addr)) + 4 : base;
  const MAX_WORDS = 1 << 20;
  if (listing.some(entry => entry.addr < base)) { error(listing.find(entry => entry.addr < base).line, 'Code or data is placed below the base address'); end = base; }
  else if ((end - base) / 4 > MAX_WORDS) { error(listing.at(-1).line, `Image spans more than ${MAX_WORDS} words; check .org/.data addresses`); end = base; }
  const words = [];
  const memLines = [`// Assembled from ${filename} by Datapath Studio. Word i is at byte address 0x${base.toString(16).padStart(8, '0')} + 4*i.`];
  for (let addr = base; addr < end; addr += 4) {
    const entry = image.get(addr >>> 0);
    const word = entry ? entry.word : 0;
    words.push(word);
    const hex = word.toString(16).padStart(8, '0');
    memLines.push(entry ? `${hex} // 0x${addr.toString(16).padStart(8, '0')}: ${entry.text.trim()}` : `${hex} // 0x${addr.toString(16).padStart(8, '0')}: (gap)`);
  }
  diagnostics.sort((a, b) => a.line - b.line);
  const ok = diagnostics.length === 0;
  return { ok, words, memText: `${memLines.join('\n')}\n`, outputName, listing, labels: Object.fromEntries(absolute), diagnostics, baseAddress: base };
}
