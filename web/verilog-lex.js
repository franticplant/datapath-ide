// Mask comments and strings without changing offsets or line numbers.
export function maskVerilog(source) {
  return source.replace(/\/\*[\s\S]*?(?:\*\/|$)|\/\/[^\n]*|"(?:\\.|[^"\\])*"/g, text => text.replace(/[^\n]/g, ' '));
}
