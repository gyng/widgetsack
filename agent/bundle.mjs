// Ship the SDK and a matching Node runtime. End users do not need Node or the pi CLI installed.
import { cp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('.', import.meta.url));
const output = path.join(root, 'runtime');
if (path.dirname(path.resolve(output)) !== path.resolve(root) || path.basename(output) !== 'runtime') throw new Error('Unexpected runtime output path');
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
for (const name of ['entry.mjs', 'runtime.mjs', 'protocol.mjs', 'package.json', 'LICENSE-pi.txt', 'node_modules']) {
	await cp(path.join(root, name), path.join(output, name), { recursive: true });
}
await cp(process.execPath, path.join(output, process.platform === 'win32' ? 'node.exe' : 'node'));
let nodeLicense;
try { nodeLicense = await readFile(path.join(path.dirname(process.execPath), 'LICENSE'), 'utf8'); }
catch {
	const response = await fetch(`https://raw.githubusercontent.com/nodejs/node/${process.version}/LICENSE`, { redirect: 'error', signal: AbortSignal.timeout(30_000) });
	if (!response.ok) throw new Error(`Could not obtain the license for Node ${process.version}`);
	nodeLicense = await response.text();
}
await writeFile(path.join(output, 'LICENSE-node.txt'), nodeLicense);
console.log(`Bundled Pi SDK and Node ${process.version} in ${output}`);
