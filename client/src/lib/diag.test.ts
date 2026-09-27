import { expect, it, vi } from 'vitest';
import { listen } from '@tauri-apps/api/event';
import { startDiagResponder } from './diag';

vi.mock('@tauri-apps/api/event', () => ({
	listen: vi.fn(),
	emit: vi.fn(),
	emitTo: vi.fn()
}));

it('removes a diagnostics listener whose registration finishes after cleanup', async () => {
	let resolve!: (off: () => void) => void;
	vi.mocked(listen).mockReturnValueOnce(new Promise((r) => (resolve = r)));
	const off = vi.fn();
	const stop = startDiagResponder(() => null);
	stop();
	resolve(off);
	await Promise.resolve();
	expect(off).toHaveBeenCalledOnce();
});
