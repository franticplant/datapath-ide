// Decode 32-bit MIPS-I instruction words (the subset used by single-cycle datapath assignments).
export const MIPS_REGISTERS = [
  '$zero', '$at', '$v0', '$v1', '$a0', '$a1', '$a2', '$a3',
  '$t0', '$t1', '$t2', '$t3', '$t4', '$t5', '$t6', '$t7',
  '$s0', '$s1', '$s2', '$s3', '$s4', '$s5', '$s6', '$s7',
  '$t8', '$t9', '$k0', '$k1', '$gp', '$sp', '$fp', '$ra',
];

export const R_TYPE = {
  0x20: 'add', 0x21: 'addu', 0x22: 'sub', 0x23: 'subu', 0x24: 'and', 0x25: 'or', 0x26: 'xor', 0x27: 'nor',
  0x2a: 'slt', 0x2b: 'sltu', 0x00: 'sll', 0x02: 'srl', 0x03: 'sra', 0x04: 'sllv', 0x06: 'srlv', 0x07: 'srav',
  0x08: 'jr', 0x09: 'jalr', 0x0c: 'syscall', 0x10: 'mfhi', 0x12: 'mflo', 0x18: 'mult', 0x19: 'multu', 0x1a: 'div', 0x1b: 'divu',
};
export const I_TYPE = {
  0x04: 'beq', 0x05: 'bne', 0x08: 'addi', 0x09: 'addiu', 0x0a: 'slti', 0x0b: 'sltiu',
  0x0c: 'andi', 0x0d: 'ori', 0x0e: 'xori', 0x0f: 'lui',
  0x20: 'lb', 0x21: 'lh', 0x23: 'lw', 0x24: 'lbu', 0x25: 'lhu', 0x28: 'sb', 0x29: 'sh', 0x2b: 'sw',
};
export const J_TYPE = { 0x02: 'j', 0x03: 'jal' };
const MEMORY_OPS = new Set(['lb', 'lh', 'lw', 'lbu', 'lhu', 'sb', 'sh', 'sw']);
const SIGNED_IMM = new Set(['addi', 'addiu', 'slti', 'sltiu', 'beq', 'bne', ...MEMORY_OPS]);

const hex = (value, digits) => `0x${(value >>> 0).toString(16).padStart(digits, '0')}`;
const bits = (value, count) => (value >>> 0).toString(2).padStart(count, '0');

// Accepts 012a4020, 0x012a4020, 32'h012a4020 (underscores allowed). Returns the word or null.
export function parseMipsWord(token) {
  const text = String(token || '').trim().replace(/_/g, '');
  const match = /^(?:32'[hH]|0[xX])?([0-9a-fA-F]{8})$/.exec(text);
  return match ? parseInt(match[1], 16) >>> 0 : null;
}

export function decodeMips(input) {
  const word = typeof input === 'number' ? input >>> 0 : parseMipsWord(input);
  if (word === null || !Number.isFinite(word)) return null;
  const op = word >>> 26;
  const rs = (word >>> 21) & 31;
  const rt = (word >>> 16) & 31;
  const rd = (word >>> 11) & 31;
  const shamt = (word >>> 6) & 31;
  const funct = word & 63;
  const imm = word & 0xffff;
  const simm = imm & 0x8000 ? imm - 0x10000 : imm;
  const target = word & 0x3ffffff;
  const r = index => MIPS_REGISTERS[index];
  const base = { word, hex: hex(word, 8), op };

  if (op === 0) {
    const name = R_TYPE[funct];
    const fields = [
      { name: 'op', bits: bits(op, 6), value: op },
      { name: 'rs', bits: bits(rs, 5), value: rs, reg: r(rs) },
      { name: 'rt', bits: bits(rt, 5), value: rt, reg: r(rt) },
      { name: 'rd', bits: bits(rd, 5), value: rd, reg: r(rd) },
      { name: 'shamt', bits: bits(shamt, 5), value: shamt },
      { name: 'funct', bits: bits(funct, 6), value: funct, hex: hex(funct, 2) },
    ];
    let asm;
    if (word === 0) asm = 'nop';
    else if (!name) asm = `unknown R-type (funct ${hex(funct, 2)})`;
    else if (name === 'jr') asm = `jr ${r(rs)}`;
    else if (name === 'jalr') asm = rd === 31 ? `jalr ${r(rs)}` : `jalr ${r(rd)}, ${r(rs)}`;
    else if (name === 'syscall') asm = 'syscall';
    else if (name === 'mfhi' || name === 'mflo') asm = `${name} ${r(rd)}`;
    else if (name === 'mult' || name === 'multu' || name === 'div' || name === 'divu') asm = `${name} ${r(rs)}, ${r(rt)}`;
    else if (name === 'sll' || name === 'srl' || name === 'sra') asm = `${name} ${r(rd)}, ${r(rt)}, ${shamt}`;
    else if (name === 'sllv' || name === 'srlv' || name === 'srav') asm = `${name} ${r(rd)}, ${r(rt)}, ${r(rs)}`;
    else asm = `${name} ${r(rd)}, ${r(rs)}, ${r(rt)}`;
    return { ...base, type: 'R', name: word === 0 ? 'nop' : name || null, asm, rs, rt, rd, shamt, funct, fields };
  }

  if (J_TYPE[op]) {
    const name = J_TYPE[op];
    const address = (target << 2) >>> 0;
    return {
      ...base, type: 'J', name, asm: `${name} ${hex(address, 8)}`, target, address,
      fields: [
        { name: 'op', bits: bits(op, 6), value: op },
        { name: 'target', bits: bits(target, 26), value: target, hex: hex(target, 7) },
      ],
    };
  }

  const name = I_TYPE[op];
  const fields = [
    { name: 'op', bits: bits(op, 6), value: op, hex: hex(op, 2) },
    { name: 'rs', bits: bits(rs, 5), value: rs, reg: r(rs) },
    { name: 'rt', bits: bits(rt, 5), value: rt, reg: r(rt) },
    { name: 'imm', bits: bits(imm, 16), value: SIGNED_IMM.has(name) ? simm : imm, hex: hex(imm, 4) },
  ];
  let asm;
  if (!name) asm = `unknown opcode ${hex(op, 2)}`;
  else if (name === 'lui') asm = `lui ${r(rt)}, ${hex(imm, 4)}`;
  else if (MEMORY_OPS.has(name)) asm = `${name} ${r(rt)}, ${simm}(${r(rs)})`;
  else if (name === 'beq' || name === 'bne') asm = `${name} ${r(rs)}, ${r(rt)}, ${simm}`;
  else if (name === 'andi' || name === 'ori' || name === 'xori') asm = `${name} ${r(rt)}, ${r(rs)}, ${hex(imm, 4)}`;
  else asm = `${name} ${r(rt)}, ${r(rs)}, ${simm}`;
  return { ...base, type: 'I', name: name || null, asm, rs, rt, imm, simm, fields };
}
