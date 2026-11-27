import { build } from 'esbuild';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const result = await build({ entryPoints: ['editor/index.js'], bundle: true, format: 'esm', target: ['es2020'], outfile: 'build/vendor/editor.js', sourcemap: false, legalComments: 'inline', metafile: true });
const zipResult = await build({ entryPoints: ['editor/zip.js'], bundle: true, format: 'esm', target: ['es2020'], outfile: 'build/vendor/zip.js', sourcemap: false, legalComments: 'inline', metafile: true });
const packages = new Set();
for (const input of [...Object.keys(result.metafile.inputs), ...Object.keys(zipResult.metafile.inputs)]) {
  if (!input.startsWith('node_modules/')) continue;
  const parts = input.slice('node_modules/'.length).split('/');
  packages.add(parts[0].startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0]);
}
const notices = [];
for (const name of [...packages].sort()) {
  const root = join('node_modules', name);
  const metadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  let license;
  try { license = await readFile(join(root, 'LICENSE'), 'utf8'); }
  catch { license = await readFile(join(root, 'LICENSE.md'), 'utf8'); }
  notices.push(`${name} ${metadata.version} (${metadata.license})\n${license.trim()}\n`);
}
await writeFile('build/vendor/LICENSES.txt', notices.join('\n---\n\n'));
