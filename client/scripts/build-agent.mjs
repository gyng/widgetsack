import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../agent/', import.meta.url));
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('Run this script through npm run build:agent.');
if (Number(process.versions.node.split('.')[0]) < 24)
	throw new Error('Bundling the studio agent requires Node.js 24 or newer.');
// These fixed package-manager arguments contain no user input.
for (const args of [
	['ci', '--ignore-scripts'],
	['run', 'bundle']
]) {
	const result = spawnSync(process.execPath, [npmCli, ...args], {
		cwd: root,
		stdio: 'inherit'
	});
	if (result.status !== 0) process.exit(result.status ?? 1);
}
