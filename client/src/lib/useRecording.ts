// React ownership of microphone acquisition, recording, and post-stop processing.
import { useCallback, useEffect, useRef, useState } from 'react';
import { startRecording, type Recorder, type Recording } from './stt';

type Consume = (recording: Recording, current: () => boolean) => Promise<void>;
export function useRecording(consume: Consume, deviceId?: string) {
	const [phase, setPhase] = useState<'idle' | 'starting' | 'recording' | 'processing'>('idle');
	const [error, setError] = useState('');
	const owner = useRef<{ disposed: boolean; locked: boolean; recorder: Recorder | null }>({
		disposed: false,
		locked: false,
		recorder: null
	});
	useEffect(() => {
		const session = owner.current;
		return () => {
			session.disposed = true;
			session.recorder?.cancel();
			session.recorder = null;
		};
	}, []);
	const toggle = useCallback(async () => {
		const session = owner.current;
		if (session.disposed || session.locked) return;
		session.locked = true;
		setError('');
		const current = () => !session.disposed;
		try {
			if (session.recorder) {
				const rec = session.recorder;
				setPhase('processing');
				const data = await rec.stop();
				session.recorder = null;
				if (current()) await consume(data, current);
			} else {
				setPhase('starting');
				const rec = await startRecording(deviceId);
				if (!current()) {
					rec.cancel();
					return;
				}
				session.recorder = rec;
				setPhase('recording');
			}
		} catch (err) {
			session.recorder?.cancel();
			session.recorder = null;
			if (current()) {
				setError(String(err));
			}
		} finally {
			session.locked = false;
			if (current()) setPhase(session.recorder ? 'recording' : 'idle');
		}
	}, [consume, deviceId]);
	const clearError = useCallback(() => setError(''), []);
	return {
		clearError,
		recording: phase === 'recording',
		busy: phase === 'starting' || phase === 'processing',
		phase,
		error,
		toggle
	};
}
