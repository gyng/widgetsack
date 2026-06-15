import { test, expect } from '@playwright/test';

// Verifies the CSS the group-hug fix relies on (flowStyle.ts): a content-basis GROUP slot floored at
// `min-height: max-content` grows to its FULL content — two fixed-height histogram rows PLUS the
// rate-text row whose `fr` (min-height:0) text leaves let it collapse out of `min-content`. So
// `min-content` lands ~one-row short and clips the rate row (the live Network "hug clips" bug), while
// `max-content` fits it. WebView2 is Chromium, same engine as this test.
const groupHtml = (floor: 'min-content' | 'max-content') => `
  <div style="height:600px; width:300px; display:flex; flex-direction:column; align-items:stretch;">
    <!-- the group slot: stale 104px flex-basis, floored at \`floor\` (the fix uses max-content) -->
    <div id="grp" style="flex:0 0 104px; min-height:${floor}; display:flex; flex-direction:column;
                          overflow:hidden; align-items:stretch;">
      <!-- the group's child renders with FlowNode \`fill\` (width/height:100%) — load-bearing for the
           min-content collapse: it's why the rate row drops out of the group's min-content. -->
      <div style="width:100%; height:100%; display:flex; flex-direction:column; align-items:stretch;
                  overflow:hidden;">
        <div style="flex:0 0 60px; margin-bottom:4px; background:#123;"></div>
        <div style="flex:0 0 60px; margin-bottom:8px; background:#135;"></div>
        <!-- rate-text row: a content row whose fr text leaves have min-height:0 (collapsible) -->
        <div id="rate" style="flex:0 0 auto; display:flex; flex-direction:row; gap:6px;">
          <span style="flex:1 1 0; min-width:0; min-height:0;">▲ 1.2 MB/s</span>
          <span style="flex:1 1 0; min-width:0; min-height:0;">▼ 3.4 MB/s</span>
        </div>
      </div>
    </div>
  </div>`;

async function measure(page: import('@playwright/test').Page) {
	return page.evaluate(() => {
		const grp = document.getElementById('grp');
		const rate = document.getElementById('rate');
		if (!grp || !rate) throw new Error('missing test nodes');
		const g = grp.getBoundingClientRect();
		const r = rate.getBoundingClientRect();
		return { grpH: g.height, grpBottom: g.bottom, rateBottom: r.bottom, rateH: r.height };
	});
}

test('a content-basis group floored at max-content sizes to its FULL content (rate row included)', async ({
	page
}) => {
	await page.setContent(groupHtml('max-content'));
	const m = await measure(page);
	// Grows well past the stale 104px flex-basis to the full content (2×60 + 12 margins + the rate
	// row ≈ 148) — so a hugged Network group fits regardless of its stored size.
	expect(m.grpH).toBeGreaterThan(144);
	// The rate row is fully inside the group box — NOT clipped at the bottom.
	expect(m.rateBottom).toBeLessThanOrEqual(m.grpBottom + 1);
	expect(m.rateH).toBeGreaterThan(5);
});

// Cross-axis (horizontal) overflow regression: a content-basis GROUP in a COL hugs along the MAIN
// axis (height) but must NOT be floored on the CROSS axis (width) — flooring width at max-content too
// forces the slot WIDER than its 170px container when the content (two un-wrapping rate texts) is
// wider, the live "Network widget overflows horizontally in studio" report. flowStyle now floors the
// main axis only; this asserts the group stays within its container width.
const crossHtml = (floorWidth: boolean) => `
  <div id="container" style="width:170px; height:600px; display:flex; flex-direction:column; align-items:stretch;">
    <div id="grp" style="flex:0 0 104px; min-height:max-content; ${
			floorWidth ? 'min-width:max-content;' : ''
		} display:flex; flex-direction:column; overflow:hidden; align-items:stretch;">
      <div style="width:100%; height:100%; display:flex; flex-direction:column; align-items:stretch; overflow:hidden;">
        <div id="rate" style="flex:0 0 auto; display:flex; flex-direction:row; gap:6px; white-space:nowrap;">
          <span style="flex:1 1 0; min-width:0;">▲ 1234.5 MB/s</span>
          <span style="flex:1 1 0; min-width:0;">▼ 6789.0 MB/s</span>
        </div>
      </div>
    </div>
  </div>`;

test('a content-basis group in a col does NOT overflow its container horizontally (cross axis unfloored)', async ({
	page
}) => {
	await page.setContent(crossHtml(false));
	const w = await page.evaluate(() => {
		const c = document.getElementById('container');
		const g = document.getElementById('grp');
		if (!c || !g) throw new Error('missing test nodes');
		return { containerW: c.getBoundingClientRect().width, grpW: g.getBoundingClientRect().width };
	});
	// Main-axis-only flooring: the group width tracks the 170px container — no horizontal overflow.
	expect(w.grpW).toBeLessThanOrEqual(w.containerW + 1);
	expect(w.grpW).toBeGreaterThan(160);

	// Sanity: the OLD both-axes behaviour (min-width:max-content) DID overflow, proving this guards a
	// real regression and isn't trivially satisfiable.
	await page.setContent(crossHtml(true));
	const overflow = await page.evaluate(() => {
		const c = document.getElementById('container');
		const g = document.getElementById('grp');
		if (!c || !g) throw new Error('missing test nodes');
		return g.getBoundingClientRect().width > c.getBoundingClientRect().width + 1;
	});
	expect(overflow).toBe(true);
});
