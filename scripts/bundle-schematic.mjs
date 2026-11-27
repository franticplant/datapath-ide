// Vendor the schematic layout engine for offline, lazy browser use:
//   build/vendor/schematic/elk.js   elkjs (in-thread layered layout) as an ES module
//   build/vendor/LICENSES.txt       web/vendor/LICENSES.txt with the schematic notice (re)appended
// RTL elaboration itself runs in the existing Icarus ivl.wasm (json.tgt, engine/tgt-json.cc).
import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const out = 'build/vendor/schematic';
await mkdir(out, { recursive: true });

await build({
  stdin: { contents: "export { default } from 'elkjs/lib/elk.bundled.js';", resolveDir: '.', sourcefile: 'elk-entry.js' },
  bundle: true, format: 'esm', target: ['es2020'], platform: 'browser', outfile: join(out, 'elk.js'), legalComments: 'inline', minify: true,
});

const root = 'node_modules/elkjs';
const metadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const license = (await readFile(join(root, 'LICENSE.md'), 'utf8')).trim();
const BEGIN = '=== Schematic layout (web/vendor/schematic/) ===';
const notice = `elkjs ${metadata.version} (${metadata.license})\n${license}\n`;
const existing = await readFile('web/vendor/LICENSES.txt', 'utf8');
const base = existing.includes(BEGIN) ? existing.slice(0, existing.indexOf(BEGIN)).trimEnd().replace(/\n---$/, '').trimEnd() : existing.trimEnd();
await writeFile('build/vendor/LICENSES.txt', `${base}\n\n---\n\n${BEGIN}\n\n${notice}`);
console.log(`Bundled schematic layout: elk.js (elkjs ${metadata.version})`);
