// Container (AGENTS.md §6) for the Audio Switcher widget: owns the Tauri wiring (list outputs, read +
// set the default endpoint) and feeds the presentational AudioSwitcher meter plain props. A bespoke
// host — like NowPlayingHost — because it sources from commands, not a sensor. Registered as the
// `audioswitch` component in registry.tsx.
import { useCallback, useEffect, useRef, useState } from 'react';
import AudioSwitcher from './meters/AudioSwitcher';
import { getDefaultAudioOutput, listAudioOutputs, setDefaultAudioOutput } from '../audio/devices';
import type { AudioDevice } from '../core/audioDevices';

type Props = { color?: string };

// The default rarely changes from outside the app, so re-poll on a relaxed cadence (+ on window focus)
// — enough to keep the highlight honest without churning the COM enumeration.
const REFRESH_MS = 8000;

export default function AudioSwitcherHost({ color }: Props) {
	const [devices, setDevices] = useState<AudioDevice[]>([]);
	const [currentId, setCurrentId] = useState<string | null>(null);
	const [busyId, setBusyId] = useState<string | null>(null);
	const refreshId = useRef(0);
	const mounted = useRef(true);
	const busy = useRef(false);

	const refresh = useCallback(async (): Promise<void> => {
		const request = ++refreshId.current;
		const [list, current] = await Promise.all([listAudioOutputs(), getDefaultAudioOutput()]);
		if (!mounted.current || request !== refreshId.current) return;
		setDevices(list);
		setCurrentId(current);
	}, []);

	useEffect(() => {
		mounted.current = true;
		let alive = true;
		const onFocus = (): void => void refresh();
		onFocus(); // initial load (kept off the effect's sync path — refresh setStates after an await)
		window.addEventListener('focus', onFocus);
		const timer = window.setInterval(() => {
			if (alive) void refresh();
		}, REFRESH_MS);
		return () => {
			alive = false;
			mounted.current = false;
			refreshId.current += 1;
			window.removeEventListener('focus', onFocus);
			window.clearInterval(timer);
		};
	}, [refresh]);

	const pick = useCallback(
		async (id: string): Promise<void> => {
			if (busy.current || id === currentId) return;
			busy.current = true;
			refreshId.current += 1;
			setBusyId(id);
			setCurrentId(id); // optimistic — snaps back via refresh() if the switch fails
			try {
				const ok = await setDefaultAudioOutput(id);
				await refresh();
				if (!ok) console.warn('audio switch failed; reverted to the real default');
			} finally {
				busy.current = false;
				if (mounted.current) setBusyId(null);
			}
		},
		[currentId, refresh]
	);

	return (
		<AudioSwitcher
			devices={devices}
			currentId={currentId}
			onPick={pick}
			busyId={busyId}
			color={color}
		/>
	);
}
