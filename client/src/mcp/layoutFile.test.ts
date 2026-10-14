import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { readLayoutFile, writeLayoutFile } from '../../mcp/layoutFile';

let dir: string;
let file: string;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), 'widgetsack-mcp-'));
	file = path.join(dir, 'nested', 'widgets.json');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

it('reads a missing layout as empty but refuses an unreadable or corrupt one', () => {
	expect(readLayoutFile(file)).toEqual({ ok: true, file: null });
	fs.mkdirSync(path.dirname(file), { recursive: true });
	for (const corrupt of ['{"version":2,', '[]', 'null']) {
		fs.writeFileSync(file, corrupt);
		const read = readLayoutFile(file);
		expect(read.ok).toBe(false);
		expect(read.ok ? '' : read.error).toMatch(/refusing to overwrite/);
	}
	// A directory in place of the file cannot be read: an IO failure, not "no layout yet".
	expect(readLayoutFile(path.dirname(file)).ok).toBe(false);
	fs.writeFileSync(file, '{"version":2,"monitors":{}}');
	expect(readLayoutFile(file)).toEqual({ ok: true, file: { version: 2, monitors: {} } });
});

it('replaces the layout through a temporary file and leaves no temporary behind', () => {
	writeLayoutFile(file, { version: 2, monitors: {} });
	writeLayoutFile(file, { version: 2, monitors: {}, theme: 'dark' });
	expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({
		version: 2,
		monitors: {},
		theme: 'dark'
	});
	expect(fs.readdirSync(path.dirname(file))).toEqual(['widgets.json']);
});

it('keeps the previous layout and cleans up when the replace fails', () => {
	// The target is a directory, so the rename cannot replace it.
	fs.mkdirSync(file, { recursive: true });
	expect(() => writeLayoutFile(file, { version: 2, monitors: {} })).toThrow();
	expect(fs.statSync(file).isDirectory()).toBe(true);
	expect(fs.readdirSync(path.dirname(file))).toEqual(['widgets.json']);
});
