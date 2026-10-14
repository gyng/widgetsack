import type { StudioSnapshot } from './studioAgentSession';
import type { StudioVerification } from '../core/studioVerification';

export async function verifyStudioSnapshot(
	expected: StudioSnapshot,
	ports: {
		ready(signal?: AbortSignal): Promise<void>;
		read(): StudioSnapshot;
		measure(current: StudioSnapshot): StudioVerification;
	},
	signal?: AbortSignal
): Promise<StudioVerification> {
	await ports.ready(signal);
	if (signal?.aborted) throw new Error('Verification was cancelled.');
	const current = ports.read();
	if (
		['monitor', 'monitorKey', 'editorTarget', 'library', 'workArea'].some(
			(key) => expected[key] !== current[key]
		)
	)
		throw new Error('The editor changed during verification. Read it again.');
	return ports.measure(current);
}
