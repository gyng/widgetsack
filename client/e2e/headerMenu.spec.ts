import { test, expect } from '@playwright/test';
import { addWidget, gotoStudio } from './helpers';

// Keyboard access to the studio bar's ≡ menu (ARIA menu pattern) and undo coalescing of typed text —
// both depend on real browser focus management + key events, so they live here rather than happy-dom.

test('the header ≡ menu takes focus on open, roves with the arrows, and Escape closes it back to the button', async ({
	page
}) => {
	await gotoStudio(page);
	const opener = page.getByRole('button', { name: 'Menu' });
	await opener.focus();
	await page.keyboard.press('Enter');
	const menu = page.locator('#studio-header-menu');
	await expect(menu).toBeVisible();
	await expect(opener).toHaveAttribute('aria-expanded', 'true');
	// Focus moved INTO the menu (its first item), not left on the button behind the backdrop.
	const items = menu.getByRole('menuitem');
	await expect(items.first()).toBeFocused();
	await page.keyboard.press('ArrowDown');
	await expect(items.nth(1)).toBeFocused();
	await page.keyboard.press('End');
	await expect(items.last()).toBeFocused();
	await page.keyboard.press('ArrowDown'); // wraps
	await expect(items.first()).toBeFocused();
	await page.keyboard.press('Escape');
	await expect(menu).toHaveCount(0);
	await expect(opener).toBeFocused();
	await expect(opener).toHaveAttribute('aria-expanded', 'false');
});

test('typing into an Inspector text field is ONE undo step, not one per keystroke', async ({
	page
}) => {
	await gotoStudio(page);
	await addWidget(page, 'Text');
	const label = page.locator('.inspector').getByRole('textbox', { name: 'label' });
	const before = await label.inputValue();
	await label.focus();
	await page.keyboard.press('End');
	await label.pressSequentially(' hello', { delay: 20 }); // six per-keystroke commits
	await expect(label).toHaveValue(`${before} hello`);
	// One Undo reverts the whole burst — the field's original value, not one character less.
	await page.locator('.studio-bar button[title^="Undo"]').click();
	await expect(label).toHaveValue(before);
});
