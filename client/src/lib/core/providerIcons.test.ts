import { describe, expect, it } from 'vitest';
import { providerIcons, readProviderIcon, resolveProviderIcon } from './providerIcons';
describe('provider icon selection', () => {
	it('accepts the bundled icons and preserves automatic and hidden choices', () => {
		for (const key of Object.keys(providerIcons)) expect(readProviderIcon(key)).toBe(key);
		expect(readProviderIcon('none')).toBe('none');
		for (const value of [undefined, null, 1, 'auto', 'unknown', 'toString'])
			expect(readProviderIcon(value)).toBe('auto');
	});
	it('uses explicit choices before source identity and detects command providers', () => {
		const provider = { source: 'codex', label: 'Work', account: '' };
		expect(resolveProviderIcon(provider)).toBe('codex');
		expect(resolveProviderIcon({ ...provider, icon: 'none' })).toBeUndefined();
		expect(resolveProviderIcon({ ...provider, icon: 'deepseek' })).toBe('deepseek');
		for (const [label, icon] of [
			['DeepSeek work', 'deepseek'],
			['OAI', 'openai'],
			['DS', 'deepseek'],
			['xAI', 'grok'],
			['Llama', 'meta'],
			['Kimi', 'moonshot'],
			['Google', 'gemini']
		])
			expect(resolveProviderIcon({ source: 'command', label, account: '', icon: 'auto' })).toBe(
				icon
			);
		expect(resolveProviderIcon({ source: 'omp', label: 'Work', account: 'anthropic' })).toBe(
			'anthropic'
		);
		expect(
			resolveProviderIcon({ source: 'command', label: 'Custom', account: '' })
		).toBeUndefined();
	});
});
