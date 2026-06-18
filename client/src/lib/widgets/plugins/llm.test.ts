import { describe, expect, it } from 'vitest';
import { registerLlmPlugin } from './llm';
import { getMeta } from '../../core/widget';

registerLlmPlugin();

describe('llm (ai-provider) plugin', () => {
	it('registers the assistant + transcribe widgets', () => {
		expect(getMeta('assistant')).toBeTruthy();
		expect(getMeta('transcribe')).toBeTruthy();
	});

	it('assistant widget exposes a speak (TTS) toggle', () => {
		const keys = (getMeta('assistant')?.configFields ?? []).map((f) => f.key);
		expect(keys).toContain('speak');
	});
});
