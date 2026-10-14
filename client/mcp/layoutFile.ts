// widgets.json I/O for the dev MCP server. A missing file is a fresh layout; an unreadable or corrupt
// one must never be replaced by an empty layout, so writers refuse to run on a failed read. Writes go
// through a sibling temporary file and a rename, so a crash mid-write cannot truncate the layout.
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { LayoutFile } from '../src/mcp/tools';

export type LayoutRead = { ok: true; file: LayoutFile | null } | { ok: false; error: string };

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function readLayoutFile(file: string): LayoutRead {
	let raw: string;
	try {
		raw = fs.readFileSync(file, 'utf8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true, file: null };
		return {
			ok: false,
			error: `cannot read ${file} (${message(error)}); refusing to overwrite it`
		};
	}
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
			throw new Error('not a JSON object');
		return { ok: true, file: parsed as LayoutFile };
	} catch (error) {
		return {
			ok: false,
			error: `${file} is not a valid layout (${message(error)}); refusing to overwrite it`
		};
	}
}

export function writeLayoutFile(file: string, layout: LayoutFile): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
	try {
		fs.writeFileSync(temporary, JSON.stringify(layout, null, 2));
		fs.renameSync(temporary, file);
	} catch (error) {
		fs.rmSync(temporary, { force: true });
		throw error;
	}
}
