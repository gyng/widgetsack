import { test, expect, type Page } from '@playwright/test';
import { gotoStudio } from './helpers';

// Rubber-band selection needs a real layout engine: the marquee box is compared against the MEASURED
// widget rects, and the press must land on the stage's covering elements (.flow-frame / the root
// FlowNode div fill the whole monitor). Regression: a press inside the monitor used to be refused as
// "not on canvas" (only a bare .world/.canvas target counted), so a marquee could only start from
// the grey margin OUTSIDE the monitor.

/** An empty point INSIDE the monitor frame: the top element is the frame / root FlowNode div (not a
 * widget, panel or control), and it sits within the .monitor-frame box. */
async function emptyPointInsideMonitor(page: Page): Promise<{ x: number; y: number }> {
	const pt = await page.evaluate(() => {
		const frame = document.querySelector('.monitor-frame')?.getBoundingClientRect();
		if (!frame) return null;
		for (let fy = 0.05; fy < 0.95; fy += 0.05)
			for (let fx = 0.05; fx < 0.95; fx += 0.05) {
				const x = frame.left + frame.width * fx;
				const y = frame.top + frame.height * fy;
				const el = document.elementFromPoint(x, y);
				if (!el || !el.closest('.canvas')) continue;
				if (el.closest('.widget, .splitter, .grid-cell, .ctag, .inspector, .outline, .nav-rail'))
					continue;
				if (el.classList.contains('flow-frame') || el.hasAttribute('data-id')) return { x, y };
			}
		return null;
	});
	if (!pt) throw new Error('no empty point inside the monitor frame found');
	return pt;
}

test('a marquee dragged from an empty point INSIDE the monitor selects the widgets it crosses', async ({
	page
}) => {
	await gotoStudio(page);
	const target = page.locator('.widget[data-type="button"]').first();
	await expect(target).toBeVisible();
	const box = (await target.boundingBox())!;
	const start = await emptyPointInsideMonitor(page);

	await page.mouse.move(start.x, start.y);
	await page.mouse.down();
	// Drag across the widget's centre so the box intersects it (several steps → real mousemoves).
	await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 8 });
	await expect(page.locator('.marquee'), 'the rubber-band is drawn while dragging').toBeVisible();
	await page.mouse.up();

	await expect(target).toHaveClass(/selected/);
	await expect(page.locator('.marquee')).toHaveCount(0);
});

test('a plain click on empty monitor space (no drag) clears the selection', async ({ page }) => {
	await gotoStudio(page);
	const target = page.locator('.widget[data-type="button"]').first();
	await target.locator('button.drag-overlay').click();
	await expect(target).toHaveClass(/selected/);
	const pt = await emptyPointInsideMonitor(page);
	await page.mouse.click(pt.x, pt.y);
	await expect(page.locator('.widget.selected')).toHaveCount(0);
});
