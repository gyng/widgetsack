import { chromium, type FullConfig } from '@playwright/test';

// Warm the dev server before the workers start. Vite serves unbundled modules and transforms each one
// on its first request, so on a fresh server the first wave of parallel tests all pay the full
// transform cost together; under machine load that measured ~25 s for the first page load, most of
// a test's 30 s budget. One serial visit to the studio and the gallery fills the transform cache so
// every test starts from a warm server. Best-effort: a failure here is left to the tests to report.
export default async function globalSetup(config: FullConfig): Promise<void> {
	const baseURL = config.projects[0]?.use.baseURL;
	if (!baseURL) return;
	const browser = await chromium.launch();
	try {
		const page = await browser.newPage({ baseURL });
		await page.goto('/');
		await page.locator('.canvas.studio.edit').waitFor({ timeout: 120_000 });
		// The studio chrome (rail, inspector, outline, panels) is lazy: wait for it to mount too.
		await page.locator('.nav-rail .nav-item').first().waitFor({ timeout: 60_000 });
		await page
			.locator('.inspector .palette')
			.first()
			.waitFor({ state: 'attached', timeout: 60_000 });
		await page.goto('/gallery/');
		await page.locator('[data-shot]').first().waitFor({ state: 'attached', timeout: 120_000 });
	} catch (error) {
		console.warn('[e2e global-setup] dev-server warm-up incomplete:', error);
	} finally {
		await browser.close();
	}
}
