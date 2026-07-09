import { describe, it, expect, vi, afterEach } from 'vitest';
import { listMicrophones, pickMime, startRecording, sttAvailable } from './stt';

afterEach(() => vi.unstubAllGlobals());

describe('stt', () => {
	it('reports unavailable in a plain environment and startRecording rejects', async () => {
		expect(sttAvailable()).toBe(false);
		await expect(startRecording()).rejects.toThrow(/not available/);
		expect(await listMicrophones()).toEqual([]); // graceful when unavailable
	});

	it('lists audioinput devices with id fallback labels', async () => {
		vi.stubGlobal('MediaRecorder', class {});
		vi.stubGlobal('navigator', {
			mediaDevices: {
				getUserMedia: async () => ({}),
				enumerateDevices: async () => [
					{ kind: 'audioinput', deviceId: 'mic-abc123', label: 'Built-in Mic' },
					{ kind: 'audioinput', deviceId: 'mic-def456', label: '' },
					{ kind: 'audiooutput', deviceId: 'spk-1', label: 'Speakers' }
				]
			}
		});
		const mics = await listMicrophones();
		expect(mics).toHaveLength(2); // outputs excluded
		expect(mics[0]).toEqual({ id: 'mic-abc123', name: 'Built-in Mic' });
		expect(mics[1].name).toMatch(/Microphone mic-de/); // blank label -> id fallback
	});

	it('pickMime returns the first supported candidate, or empty when none', () => {
		vi.stubGlobal('MediaRecorder', {
			isTypeSupported: (m: string) => m === 'audio/webm'
		});
		expect(pickMime()).toBe('audio/webm');

		vi.stubGlobal('MediaRecorder', { isTypeSupported: () => false });
		expect(pickMime()).toBe('');

		// No isTypeSupported on the constructor -> empty (let the browser default).
		vi.stubGlobal('MediaRecorder', class {});
		expect(pickMime()).toBe('');
	});

	it('listMicrophones returns [] when enumerateDevices throws', async () => {
		vi.stubGlobal('MediaRecorder', class {});
		vi.stubGlobal('navigator', {
			mediaDevices: {
				getUserMedia: async () => ({}),
				enumerateDevices: async () => {
					throw new Error('blocked');
				}
			}
		});
		expect(await listMicrophones()).toEqual([]);
	});

	it('stop() resolves (does not hang) even when the recorder already went inactive', async () => {
		const tracks = [{ stop: vi.fn() }];
		// Record each constructed recorder (pushing `this` is not a `this`-alias) so the test can reach in
		// and simulate the recorder auto-stopping before the user clicks stop.
		const created: FakeRecorder[] = [];
		class FakeRecorder {
			state = 'recording';
			mimeType = 'audio/webm';
			ondataavailable: ((e: unknown) => void) | null = null;
			onstop: (() => void) | null = null;
			onerror: (() => void) | null = null;
			constructor() {
				created.push(this);
			}
			start(): void {
				/* no-op: the mock doesn't capture audio */
			}
			stop(): void {
				this.state = 'inactive';
				this.onstop?.();
			}
			static isTypeSupported(): boolean {
				return true;
			}
		}
		vi.stubGlobal('MediaRecorder', FakeRecorder);
		vi.stubGlobal('navigator', {
			mediaDevices: { getUserMedia: async () => ({ getTracks: () => tracks }) }
		});

		const rec = await startRecording();
		const inst = created[0];
		if (!inst) throw new Error('expected a FakeRecorder to be constructed');
		// Simulate the recorder auto-stopping (e.g. mic unplugged) before the user clicks stop.
		inst.state = 'inactive';
		const result = await rec.stop(); // must settle, not hang
		expect(result.mime).toMatch(/audio/);
		expect(tracks[0].stop).toHaveBeenCalled(); // mic released
	});

	it('records, applies the device constraint, and stop() returns the captured bytes', async () => {
		const tracks = [{ stop: vi.fn() }, { stop: vi.fn() }];
		let constraints: unknown;
		const created: FakeRecorder[] = [];
		class FakeRecorder {
			state = 'recording';
			mimeType = 'audio/webm;codecs=opus';
			ondataavailable: ((e: { data: Blob }) => void) | null = null;
			onstop: (() => void) | null = null;
			onerror: (() => void) | null = null;
			started = false;
			constructor(
				public stream: unknown,
				public opts: unknown
			) {
				created.push(this);
			}
			start(): void {
				this.started = true;
			}
			stop(): void {
				this.state = 'inactive';
				this.onstop?.();
			}
			static isTypeSupported(m: string): boolean {
				return m === 'audio/webm;codecs=opus';
			}
		}
		vi.stubGlobal('MediaRecorder', FakeRecorder);
		vi.stubGlobal('navigator', {
			mediaDevices: {
				getUserMedia: async (c: unknown) => {
					constraints = c;
					return { getTracks: () => tracks };
				}
			}
		});
		// happy-dom lacks Blob.arrayBuffer here; provide a minimal Blob that yields the chunk bytes.
		vi.stubGlobal(
			'Blob',
			class {
				type: string;
				constructor(
					public parts: Uint8Array[],
					opts?: { type?: string }
				) {
					this.type = opts?.type ?? '';
				}
				arrayBuffer(): Promise<ArrayBuffer> {
					return Promise.resolve(new Uint8Array([7, 8, 9]).buffer);
				}
			}
		);

		const rec = await startRecording('mic-42');
		const inst = created[0]!;
		expect(inst.started).toBe(true);
		expect((inst.opts as { mimeType: string }).mimeType).toBe('audio/webm;codecs=opus');
		expect(constraints).toEqual({ audio: { deviceId: { exact: 'mic-42' } } });

		// A non-empty data chunk is kept; an empty chunk is ignored.
		inst.ondataavailable!({ data: { size: 3 } as Blob });
		inst.ondataavailable!({ data: { size: 0 } as Blob }); // empty chunk ignored
		const result = await rec.stop();
		expect(Array.from(result.bytes)).toEqual([7, 8, 9]);
		expect(result.mime).toBe('audio/webm;codecs=opus');
		expect(tracks[0]!.stop).toHaveBeenCalled();
		expect(tracks[1]!.stop).toHaveBeenCalled();
	});

	it('stop() falls back to audio/webm when neither the recorder nor the blob report a mime', async () => {
		const tracks = [{ stop: vi.fn() }];
		const created: FakeRecorder[] = [];
		class FakeRecorder {
			state = 'recording';
			mimeType = ''; // -> falls through to `mime` (also '' here) -> 'audio/webm'
			ondataavailable: ((e: { data: Blob }) => void) | null = null;
			onstop: (() => void) | null = null;
			onerror: (() => void) | null = null;
			constructor() {
				created.push(this);
			}
			start(): void {
				/* no-op */
			}
			stop(): void {
				this.state = 'inactive';
				this.onstop?.();
			}
			static isTypeSupported(): boolean {
				return false; // pickMime -> ''
			}
		}
		vi.stubGlobal('MediaRecorder', FakeRecorder);
		vi.stubGlobal('navigator', {
			mediaDevices: { getUserMedia: async () => ({ getTracks: () => tracks }) }
		});
		vi.stubGlobal(
			'Blob',
			class {
				type = ''; // -> mime fallback 'audio/webm'
				constructor(public parts: unknown[]) {}
				arrayBuffer(): Promise<ArrayBuffer> {
					return Promise.resolve(new Uint8Array().buffer);
				}
			}
		);

		const rec = await startRecording();
		const result = await rec.stop();
		expect(result.mime).toBe('audio/webm');
	});

	it('stop() rejects when the recorder errors, and cancel() releases the mic', async () => {
		const tracks = [{ stop: vi.fn() }];
		const created: FakeRecorder[] = [];
		class FakeRecorder {
			state = 'recording';
			mimeType = '';
			ondataavailable: ((e: { data: Blob }) => void) | null = null;
			onstop: (() => void) | null = null;
			onerror: (() => void) | null = null;
			constructor() {
				created.push(this);
			}
			start(): void {
				/* no-op */
			}
			stop(): void {
				/* leave state 'recording' so stop()'s rec.stop() path runs onerror */
			}
			static isTypeSupported(): boolean {
				return false; // -> pickMime returns '', MediaRecorder constructed with undefined opts
			}
		}
		vi.stubGlobal('MediaRecorder', FakeRecorder);
		vi.stubGlobal('navigator', {
			mediaDevices: { getUserMedia: async () => ({ getTracks: () => tracks }) }
		});

		const rec = await startRecording(); // no deviceId -> audio:true
		const inst = created[0]!;
		const pending = rec.stop();
		inst.onerror!(); // recorder fails
		await expect(pending).rejects.toThrow(/recording failed/);
		expect(tracks[0]!.stop).toHaveBeenCalled();

		// cancel() on an active recorder also releases tracks (swallowing any stop() throw).
		tracks[0]!.stop.mockClear();
		const rec2 = await startRecording();
		const inst2 = created[1]!;
		inst2.stop = () => {
			throw new Error('already stopped');
		};
		expect(() => rec2.cancel()).not.toThrow();
		expect(tracks[0]!.stop).toHaveBeenCalled();
	});

	it('cancel() skips rec.stop() when the recorder is already inactive, still releasing the mic', async () => {
		const tracks = [{ stop: vi.fn() }];
		const created: FakeRecorder[] = [];
		class FakeRecorder {
			state = 'recording';
			mimeType = '';
			ondataavailable: ((e: { data: Blob }) => void) | null = null;
			onstop: (() => void) | null = null;
			onerror: (() => void) | null = null;
			stopped = 0;
			constructor() {
				created.push(this);
			}
			start(): void {
				/* no-op */
			}
			stop(): void {
				this.stopped++;
			}
			static isTypeSupported(): boolean {
				return false;
			}
		}
		vi.stubGlobal('MediaRecorder', FakeRecorder);
		vi.stubGlobal('navigator', {
			mediaDevices: { getUserMedia: async () => ({ getTracks: () => tracks }) }
		});

		const rec = await startRecording();
		const inst = created[0]!;
		inst.state = 'inactive'; // the recorder already stopped on its own
		rec.cancel();
		expect(inst.stopped).toBe(0); // no redundant stop() on an inactive recorder
		expect(tracks[0]!.stop).toHaveBeenCalled(); // mic still released
	});
});
