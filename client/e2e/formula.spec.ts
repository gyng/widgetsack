import { test, expect } from '@playwright/test';
import { gotoStudio, addWidget } from './helpers';

// The QuickJS formula engine, end-to-end in a real browser: typing an expression into the Inspector
// re-renders the on-canvas meter. This proves the WASM sandbox instantiates and the override pipeline
// reaches the meter — neither of which a happy-dom unit test exercises. Engine init is async, so we
// rely on Playwright's auto-retrying expect. Formulas must be CONSTANT (no live sensors under the mock).

test('Gauge value formula evaluates live via QuickJS (no sensor needed)', async ({ page }) => {
	await gotoStudio(page);
	const gauge = await addWidget(page, 'Gauge');
	const value = gauge.locator('[data-part="value"]');
	await page.locator('.inspector summary').filter({ hasText: 'Advanced expressions' }).click();
	await expect(value, 'starts as the null placeholder').toContainText('–');

	await page.locator('.inspector textarea.cfg-expr').first().fill('1 + 1');
	await expect(value, 'constant formula resolves to 2').toContainText('2');
});

test('Text template formula renders the evaluated string and degrades gracefully', async ({
	page
}) => {
	await gotoStudio(page);
	const text = await addWidget(page, 'Text');
	const value = text.locator('[data-part="value"]');
	await page.locator('.inspector summary').filter({ hasText: 'Advanced expressions' }).click();

	await page.locator('.inspector textarea.cfg-expr').first().fill('sum {1 + 1}');
	await expect(value).toHaveText('sum 2');

	// An expression referencing an absent sensor resolves to the em-dash, NOT a crash or the raw {…}.
	await page.locator('.inspector textarea.cfg-expr').first().fill('x {nope.bad}');
	await expect(value).toContainText('x');
	await expect(value).not.toContainText('nope');
});

test('referenced-sensor hint lists refs and flags unknown ids', async ({ page }) => {
	await gotoStudio(page);
	await addWidget(page, 'Gauge');
	await page.locator('.inspector summary').filter({ hasText: 'Advanced expressions' }).click();
	await page.locator('.inspector textarea.cfg-expr').first().fill('cpu.total + nope.bad');

	const refs = page.locator('.inspector .cfg-expr-refs').first();
	await expect(refs).toContainText('cpu.total');
	await expect(refs.locator('.unknown'), 'unknown sensor id is flagged').toContainText('nope');
});
