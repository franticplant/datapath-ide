import { maskVerilog } from './verilog-lex.js';

export function formatVerilog(source, { tabWidth = 2 } = {}) {
  source = source.replace(/\r\n?/g, '\n');
  const masked = maskVerilog(source).split('\n');
  const protectedRanges = [...source.matchAll(/\/\*[\s\S]*?(?:\*\/|$)|\/\/[^\n]*|"(?:\\.|[^"\\])*"/g)].map(m => [m.index, m.index + m[0].length]);
  let offset = 0;
  let depth = 0;
  const opens = new Set(['module', 'macromodule', 'begin', 'case', 'casex', 'casez', 'function', 'task', 'generate', 'fork']);
  const closes = new Set(['endmodule', 'end', 'endcase', 'endfunction', 'endtask', 'endgenerate', 'join', 'join_any', 'join_none']);
  return source.split('\n').map((line, index) => {
    const code = masked[index];
    const words = [...code.matchAll(/\b(?:module|macromodule|endmodule|begin|end|case|casex|casez|endcase|function|endfunction|task|endtask|generate|endgenerate|fork|join|join_any|join_none)\b/g)];
    const leadingClose = words.length && closes.has(words[0][0]) && !code.slice(0, words[0].index).trim();
    const indent = Math.max(0, depth - (leadingClose ? 1 : 0));
    for (const [word] of words) depth = Math.max(0, depth + (opens.has(word) ? 1 : -1));
    const lineStart = offset;
    offset += line.length + 1;
    const inToken = protectedRanges.some(([start, end]) => start < lineStart && end > lineStart);
    if (inToken) return line;
    const leading = line.match(/^\s*/)[0].length;
    let end = line.length;
    while (end > leading && /\s/.test(line[end - 1]) && !protectedRanges.some(([start, stop]) => start <= lineStart + end - 1 && stop > lineStart + end - 1)) end--;
    const content = line.slice(leading, end);
    return content ? ' '.repeat(indent * Math.max(0, Math.min(8, tabWidth))) + content : '';
  }).join('\n');
}
