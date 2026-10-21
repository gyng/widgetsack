// Screenshot rig: render the widget gallery (client/gallery) in a headless Chromium and capture one
// PNG per widget type + the demo layout, into docs/img/. Self-contained — spins up its own Vite
// server, needs no Tauri, and is deterministic (the gallery freezes the clock and seeds synthetic
// data). Run from client/:  npm run gen:shots
//
// Output:
//   docs/img/widgets/<type>.png   — one per registered widget ([data-shot="widget-<type>"])
//   docs/img/demo.png             — the demo sidebar ([data-shot="demo"])

import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';
import { createServer } from 'vite';

const clientRoot = fileURLToPath(new URL('..', import.meta.url));
const outDir = path.resolve(clientRoot, '../docs/img');
// Optional focused capture avoids regenerating unrelated documentation images.
const typeArg = process.argv.find((arg) => arg.startsWith('--types='));
const wanted = typeArg ? new Set(typeArg.slice('--types='.length).split(',')) : null;
const presetsOnly = process.argv.includes('--presets');

async function main() {
	const server = await createServer({
		root: clientRoot,
		configFile: path.join(clientRoot, 'vite.config.ts'),
		logLevel: 'warn',
		server: { port: 5199, strictPort: false }
	});
	await server.listen();
	const base = server.resolvedUrls?.local?.[0];
	if (!base) throw new Error('Vite did not report a local URL');
	const url = new URL(presetsOnly ? 'gallery/?presets' : 'gallery/', base).href;
	console.log(`gallery: ${url}`);

	// deviceScaleFactor 2 → crisp 2× screenshots for the docs.
	const browser = await chromium.launch();
	const page = await browser.newPage({ deviceScaleFactor: 2 });
	const errors = [];
	page.on('pageerror', (e) => errors.push(String(e)));

	await page.goto(url, { waitUntil: 'load' });
	await page.waitForSelector('body[data-ready="true"]', { timeout: 20000 });
	// Let fonts + the now-playing cover (a blob image) settle before capturing.
	await page.evaluate(async () => {
		await document.fonts.ready;
		await Promise.all(
			Array.from(document.images).map((img) =>
				img.complete
					? null
					: new Promise((res) => {
							img.onload = img.onerror = res;
						})
			)
		);
	});
	await page.waitForTimeout(300);

	const shots = await page.$$('[data-shot]');
	let n = 0;
	for (const el of shots) {
		const name = await el.getAttribute('data-shot');
		if (!name) continue;
		if (presetsOnly && !name.startsWith('preset-')) continue;
		if (wanted && !wanted.has(name.replace(/^widget-/, ''))) continue;
		const rel = name.startsWith('preset-')
			? path.join('presets', `${name.slice('preset-'.length)}.png`)
			: name === 'demo'
				? 'demo.png'
				: path.join('widgets', `${name.replace(/^widget-/, '')}.png`);
		const file = path.join(outDir, rel);
		await mkdir(path.dirname(file), { recursive: true });
		await el.screenshot({ path: file });
		console.log(`  ${rel}`);
		n++;
	}
	if (wanted || presetsOnly) {
		await browser.close();
		await server.close();
		if (errors.length) throw new Error(errors.join('\n'));
		console.log(`wrote ${n} focused screenshot(s) to ${outDir}`);
		return;
	}

	// The studio (editor) view — its own page (gallery/studio.html) renders the real app in studio
	// role under the Tauri dev mock. Capture the whole viewport (the editor is full-window chrome),
	// not a [data-shot] element.
	const studioPage = await browser.newPage({
		deviceScaleFactor: 2,
		viewport: { width: 1600, height: 1000 }
	});
	studioPage.on('pageerror', (e) => errors.push(`studio: ${e}`));
	await studioPage.goto(new URL('gallery/studio.html', base).href, { waitUntil: 'load' });
	// The studio body has no intrinsic size (all chrome is position:fixed), so wait for `attached`,
	// not `visible`; then for the (visible) toolbar to confirm the editor actually rendered.
	await studioPage.waitForSelector('body[data-ready="true"]', {
		state: 'attached',
		timeout: 20000
	});
	await studioPage.waitForSelector('.canvas.studio .studio-bar', { timeout: 20000 });
	await studioPage.locator('.outline.docked').waitFor();
	await studioPage.locator('.inspector').waitFor();
	await studioPage.evaluate(() => document.fonts.ready);
	// Select the needle gauge so the shot shows a REAL Inspector (sensor/config/style fields)
	// instead of the empty "select a widget" stub. Click the widget on the stage like a user would.
	await studioPage.click('[data-w="sg-g-needle"]', { timeout: 5000 }).catch(() => {
		console.warn('  studio.png: showcase widget not found — capturing unselected');
	});
	await studioPage
		.locator('.inspector')
		.getByRole('tab', { name: 'Content', exact: true })
		.waitFor();
	await studioPage.evaluate(() => document.fonts.ready);
	await studioPage.screenshot({ path: path.join(outDir, 'studio.png') });
	console.log('  studio.png');
	n++;
	// Capture Build with the same catalog, a real template copy and its editing context.
	await studioPage.locator('[data-section="widget-designer"]').click();
	const build = studioPage.locator('.designer-list');
	await build.getByRole('combobox', { name: 'Catalog section' }).click();
	await studioPage.getByRole('option', { name: 'Templates', exact: true }).click();
	await build.getByRole('searchbox').fill('clock');
	await build.getByRole('button', { name: 'Previews', exact: true }).click();
	await build.getByRole('button', { name: 'Use Clock (JP weekday) template', exact: true }).click();
	await expect(studioPage.locator('.def-banner')).toContainText('Clock (JP weekday)');
	const clock = studioPage.locator('.world .widget:has(.np-clock)').first();
	await clock.click();
	// Use the editor's own zoom gesture so a tiny template is shown at a readable scale.
	const stage = await studioPage.locator('.world').boundingBox();
	await studioPage.mouse.move(stage.x + stage.width / 2, stage.y + stage.height / 2);
	for (let step = 0; step < 6; step++) await studioPage.mouse.wheel(0, 100);
	await expect(
		studioPage.locator('.inspector').getByRole('tab', { name: 'Content', exact: true })
	).toBeVisible();
	await studioPage.evaluate(() => document.fonts.ready);
	await studioPage.screenshot({ path: path.join(outDir, 'build.png') });
	console.log('  build.png');
	n++;
	await studioPage.close();

	await browser.close();
	await server.close();

	if (errors.length) {
		console.error(`\n${errors.length} page error(s):`);
		errors.forEach((e) => console.error('  ' + e));
		process.exitCode = 1;
	}
	console.log(`\nwrote ${n} screenshot(s) to ${outDir}`);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
