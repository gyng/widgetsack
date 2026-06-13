// Container (AGENTS.md §6) for the Volume widget: owns the Tauri wiring (read/set the system master
// volume + mute) and feeds the presentational Volume meter plain props. Bespoke host — like
// AudioSwitcherHost — sourcing from commands, not a sensor. Registered as `volume` in registry.tsx.
import { useCallback, useEffect, useRef, useState } from 'react';
import Volume from './meters/Volume';
import { getAudioVolume, setAudioMute, setAudioVolume } from '../audio/volume';

type Props = { color?: string };

const POLL_MS = 1000;

export default function VolumeHost({ color }: Props) {
	const [level, setLevel] = useState<number | null>(null);
	const [muted, setMuted] = useState(false);
	// While the user is actively dragging the slider, suppress the poll so it can't yank the thumb back
	// to the (slightly stale) backend value mid-drag. Released a beat after the last change.
	const holdRef = useRef(false);
	const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

	useEffect(() => {
		let alive = true;
		const poll = (): void =>
			void getAudioVolume().then((v) => {
				if (alive && v && !holdRef.current) {
					setLevel(v.level);
					setMuted(v.muted);
				}
			});
		poll();
		const t = window.setInterval(poll, POLL_MS);
		return () => {
			alive = false;
			window.clearInterval(t);
			if (holdTimer.current) clearTimeout(holdTimer.current);
		};
	}, []);

	const onSet = useCallback((l: number): void => {
		holdRef.current = true;
		setLevel(l); // optimistic
		void setAudioVolume(l);
		if (holdTimer.current) clearTimeout(holdTimer.current);
		holdTimer.current = setTimeout(() => {
			holdRef.current = false;
		}, 400);
	}, []);

	const onToggleMute = useCallback((): void => {
		setMuted((prev) => {
			const next = !prev;
			void setAudioMute(next);
			return next;
		});
	}, []);

	return (
		<Volume level={level} muted={muted} onSet={onSet} onToggleMute={onToggleMute} color={color} />
	);
}
