import { useEffect, useRef, useState } from 'react';
import {
	getAudioMixer,
	setAudioSession,
	setMicrophoneMute,
	type MixerSnapshot
} from '../audio/mixer';
import AudioMixer from './meters/AudioMixer';
import { writeQueue } from '../core/writeQueue';
export default function AudioMixerHost({
	showMicrophone = true,
	editMode = false,
	previewMode = false
}: {
	showMicrophone?: boolean;
	editMode?: boolean;
	previewMode?: boolean;
}) {
	const [snapshot, setSnapshot] = useState<MixerSnapshot | null>(null);
	const [error, setError] = useState('');
	const [busy, setBusy] = useState(false);
	const mounted = useRef(false);
	const confirmed = useRef<MixerSnapshot | null>(null);
	const [queue] = useState(writeQueue);
	const generation = useRef(0);
	useEffect(() => {
		mounted.current = true;
		let alive = true,
			running = false;
		const poll = async () => {
			if (!alive || running || queue.pending() || document.visibilityState === 'hidden') return;
			running = true;
			const version = generation.current;
			try {
				const data = await getAudioMixer();
				if (alive && version === generation.current) {
					confirmed.current = data;
					setSnapshot(data);
					setError('');
				}
			} catch (e) {
				if (alive && version === generation.current) setError(String(e));
			} finally {
				running = false;
			}
		};
		void poll();
		const timer = setInterval(() => {
			void poll();
		}, 3000);
		const visible = () => {
			void poll();
		};
		document.addEventListener('visibilitychange', visible);
		return () => {
			alive = false;
			mounted.current = false;
			clearInterval(timer);
			document.removeEventListener('visibilitychange', visible);
		};
	}, [queue]);
	const write = async (operation: () => Promise<void>, key?: string, optimistic?: () => void) => {
		if (editMode || previewMode) return;
		optimistic?.();
		const version = ++generation.current;
		setBusy(true);
		try {
			await queue.enqueue(async () => {
				if (!mounted.current) return false;
				await operation();
				if (!mounted.current) return false;
				const data = await getAudioMixer();
				if (mounted.current) {
					confirmed.current = data;
					if (version === generation.current) {
						setSnapshot(data);
						setError('');
					}
				}
				return true;
			}, key);
		} catch (e) {
			if (mounted.current && version === generation.current) {
				setSnapshot(confirmed.current);
				setError(String(e));
			}
		} finally {
			if (mounted.current && version === generation.current) setBusy(false);
		}
	};
	return (
		<AudioMixer
			snapshot={snapshot}
			error={error}
			busy={busy}
			showMicrophone={showMicrophone}
			editMode={editMode || previewMode}
			onLevel={(id, level) => {
				// A slider is rendered only for a loaded session. Keep dragging responsive while writes queue.
				void write(
					() => setAudioSession(id, level, null),
					id,
					() =>
						setSnapshot({
							...snapshot!,
							sessions: snapshot!.sessions.map((s) => (s.id === id ? { ...s, level } : s))
						})
				);
			}}
			onMute={(id, muted) => {
				void write(() => setAudioSession(id, null, muted));
			}}
			onMicrophone={(muted) => {
				void write(() => setMicrophoneMute(muted));
			}}
		/>
	);
}
