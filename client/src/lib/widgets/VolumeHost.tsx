// Container (AGENTS.md §6) for the Volume widget: owns the Tauri wiring (read/set the system master
// volume + mute) and feeds the presentational Volume meter plain props. Bespoke host — like
// AudioSwitcherHost — sourcing from commands, not a sensor. Registered as `volume` in registry.tsx.
import { useCallback, useEffect, useRef, useState } from 'react';
import Volume from './meters/Volume';
import { getAudioVolume, setAudioMute, setAudioVolume } from '../audio/volume';

type Props = { color?: string };

// Each poll is a Core Audio COM round-trip on a pool thread (audio.rs get_audio_volume); the
// system volume rarely changes behind the widget's back, so 3 s is plenty — and the widget's own
// writes update the display optimistically. Polling pauses entirely while the window is hidden.
const POLL_MS = 3000;

export default function VolumeHost({ color }: Props) {
	const [level, setLevel] = useState<number | null>(null);
	const [muted, setMuted] = useState(false);
	// While the user is actively dragging the slider, suppress the poll so it can't yank the thumb back
	// to the (slightly stale) backend value mid-drag. Released a beat after the last change.
	const holdRef = useRef(false);
	const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const queuedVolume = useRef<number | null>(null);
	const volumeWriting = useRef(false);
	const queuedMute = useRef<boolean | null>(null);
	const muteWriting = useRef(false);

	useEffect(() => {
		let alive = true;
		const poll = (): void =>
			void getAudioVolume().then((v) => {
				if (alive && v && !holdRef.current) {
					setLevel(v.level);
					setMuted(v.muted);
				}
			});
		// Poll only while the window can be seen: a hidden (minimised / occluded) studio or overlay
		// would otherwise keep waking the audio stack for a readout nobody sees. On becoming visible
		// again, refresh immediately (the level may have moved meanwhile) and resume the cadence.
		let timer: number | null = null;
		const stop = (): void => {
			if (timer !== null) window.clearInterval(timer);
			timer = null;
		};
		const start = (): void => {
			poll();
			if (timer === null) timer = window.setInterval(poll, POLL_MS);
		};
		const onVisibility = (): void => {
			if (document.visibilityState === 'hidden') stop();
			else start();
		};
		if (document.visibilityState !== 'hidden') start();
		document.addEventListener('visibilitychange', onVisibility);
		return () => {
			alive = false;
			stop();
			document.removeEventListener('visibilitychange', onVisibility);
			if (holdTimer.current) clearTimeout(holdTimer.current);
		};
	}, []);

	const flushVolume = useCallback(async (): Promise<void> => {
		if (volumeWriting.current) return;
		volumeWriting.current = true;
		try {
			while (queuedVolume.current !== null) {
				const value = queuedVolume.current;
				queuedVolume.current = null;
				try {
					await setAudioVolume(value);
				} catch (error) {
					console.warn('volume write failed', error);
				}
			}
		} finally {
			volumeWriting.current = false;
		}
	}, []);

	const flushMute = useCallback(async (): Promise<void> => {
		if (muteWriting.current) return;
		muteWriting.current = true;
		try {
			while (queuedMute.current !== null) {
				const value = queuedMute.current;
				queuedMute.current = null;
				try {
					await setAudioMute(value);
				} catch (error) {
					console.warn('mute write failed', error);
				}
			}
		} finally {
			muteWriting.current = false;
		}
	}, []);

	const onSet = useCallback(
		(l: number): void => {
			holdRef.current = true;
			setLevel(l); // optimistic
			queuedVolume.current = l;
			void flushVolume();
			if (holdTimer.current) clearTimeout(holdTimer.current);
			holdTimer.current = setTimeout(() => {
				holdRef.current = false;
			}, 400);
		},
		[flushVolume]
	);

	const onToggleMute = useCallback((): void => {
		setMuted((prev) => {
			const next = !prev;
			queuedMute.current = next;
			void flushMute();
			return next;
		});
	}, [flushMute]);

	return (
		<Volume level={level} muted={muted} onSet={onSet} onToggleMute={onToggleMute} color={color} />
	);
}
