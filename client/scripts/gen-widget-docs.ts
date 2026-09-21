// Generate (or validate) the committed docs/ reference files from the code that defines them
// (the single source of truth):
//   docs/widgets.md     — every shipped widget type + its config schema (the widget registry)
//   docs/templating.md  — the formula/template language (helper fns, formats, expr fields)
//   docs/theming.md     — the theming system (token vocabulary, cascade, scoping)
//   npm run gen:docs    — (re)write the files
//   npm run check:docs  — exit non-zero if any committed file is stale (for CI / pre-commit)
// Importing core/widget registers the built-in (shipped) metas; registerBuiltinPlugins() adds the
// plugin-registered types (nowplaying, assistant, transcribe, weather, rss, ticker, agenda, airquality,
// sunmoon, ha.*). Their metas are plain data inside each plugin module, and those modules import
// cleanly under vite-node (nothing touches browser globals at module scope), so the reference covers
// the COMPLETE registry — the same set the studio's "Copy widget reference" button produces.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listMetas } from '../src/lib/core/widget';
import { pluginLoadErrors, registerBuiltinPlugins } from '../src/lib/widgets/plugins/index';
import { widgetReferenceMarkdown } from '../src/lib/core/widgetDocs';
import { templatingReferenceMarkdown } from '../src/lib/core/templatingDocs';
import { themingReferenceMarkdown } from '../src/lib/core/themingDocs';

const check = process.argv.includes('--check');
registerBuiltinPlugins();
// A plugin whose registration threw would silently drop its widget types from the reference.
const loadErrors = pluginLoadErrors();
if (loadErrors.length) {
	for (const e of loadErrors) console.error(`✗ plugin "${e.id}" failed to register: ${e.error}`);
	process.exit(1);
}
const metas = listMetas();
// Compare line-ending-insensitively so a CRLF checkout (git autocrlf) doesn't read as stale.
const norm = (s: string): string => s.replace(/\r\n/g, '\n');

const docs: { rel: string; md: string; label: string }[] = [
	{
		rel: '../../docs/widgets.md',
		md: widgetReferenceMarkdown(metas),
		label: `${metas.length} widgets (built-in + plugin)`
	},
	{
		rel: '../../docs/templating.md',
		md: templatingReferenceMarkdown(metas),
		label: 'templating language'
	},
	{
		rel: '../../docs/theming.md',
		md: themingReferenceMarkdown(),
		label: 'theming system'
	}
];

let stale = false;
for (const doc of docs) {
	const out = fileURLToPath(new URL(doc.rel, import.meta.url));
	if (check) {
		const current = existsSync(out) ? readFileSync(out, 'utf8') : '';
		if (norm(current) !== norm(doc.md)) {
			console.error(
				`✗ ${doc.rel.replace('../../', '')} is out of date.\n` +
					'  Run "npm run gen:docs" (in client/) and commit the result.'
			);
			stale = true;
		} else {
			console.log(`✓ ${doc.rel.replace('../../', '')} is up to date (${doc.label}).`);
		}
	} else {
		mkdirSync(dirname(out), { recursive: true });
		writeFileSync(out, doc.md);
		console.log(`wrote ${out} (${doc.label})`);
	}
}

if (check && stale) process.exit(1);
