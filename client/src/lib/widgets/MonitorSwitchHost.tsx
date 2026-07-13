// Container (AGENTS.md §6) for the Monitor Switch widget: owns the Tauri wiring (list monitors, read
// current/supported DDC input + display mode, switch via VCP 0x60) and feeds the presentational
// MonitorSwitch meter plain props. A bespoke host — like AudioSwitcherHost — because it sources from
// commands, not a sensor. Registered as the `monitorswitch` component in registry.tsx. The pure
// shaping (which rows, names, stats) lives in core/monitorInputs.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import MonitorSwitch from './meters/MonitorSwitch';
import { listMonitorInputs, setMonitorInput, type MonitorInputs } from '../ddc/monitors';
import { formatStats, monitorInputRows } from '../core/monitorInputs';

// Config fields, spread onto the host as props by WidgetHost (see widget.ts `monitorswitch` meta).
type Props = {
	monitor?: string; // GDI device name (\\.\DISPLAYn); blank = the primary monitor
	sources?: string; // optional `code=label` spec choosing/ordering/renaming inputs
	label?: string; // widget title override
	showCurrent?: boolean;
	showStats?: boolean;
	compact?: boolean; // compact list instead of large touch buttons
	color?: string;
};

// DDC reads are slow and the active input rarely changes from outside the app, so poll on a relaxed
// cadence (+ on window focus), like the Audio Switcher — enough to keep the highlight honest.
const REFRESH_MS = 8000;

export default function MonitorSwitchHost({
	monitor,
	sources,
	label,
	showCurrent = true,
	showStats = false,
	compact = false,
	color
}: Props) {
	const target = monitor?.trim() ?? '';
	const [snapshot, setSnapshot] = useState<{
		target: string;
		selected: MonitorInputs | null;
		missing: boolean;
	} | null>(null);
	const [busyValue, setBusyValue] = useState<number | null>(null);
	const refreshId = useRef(0);
	const mounted = useRef(true);
	const busy = useRef(false);
	const targetRef = useRef(target);
	targetRef.current = target;
	const currentSnapshot = snapshot?.target === target ? snapshot : null;
	const selected = currentSnapshot?.selected ?? null;
	const missing = currentSnapshot?.missing ?? false;
	const loading = currentSnapshot === null;

	const refresh = useCallback(async (): Promise<void> => {
		const request = ++refreshId.current;
		const list = await listMonitorInputs(target || undefined);
		const found = target
			? (list.find((m) => m.gdi === target) ?? null)
			: (list.find((m) => m.primary) ?? list[0] ?? null);
		if (!mounted.current || request !== refreshId.current || targetRef.current !== target) return;
		setSnapshot({ target, selected: found, missing: Boolean(target) && found === null });
	}, [target]);

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
		async (value: number): Promise<void> => {
			const gdi = selected?.gdi;
			if (busy.current || !gdi) return;
			busy.current = true;
			refreshId.current += 1;
			setBusyValue(value);
			setSnapshot((current) =>
				current?.target === target && current.selected
					? { ...current, selected: { ...current.selected, current_input: value } }
					: current
			); // optimistic highlight
			try {
				const ok = await setMonitorInput(gdi, value);
				if (targetRef.current === target) {
					await refresh(); // reconcile with what the monitor actually reports (snaps back on failure)
				}
				if (!ok) console.warn('monitor input switch failed; reverted to the reported input');
			} finally {
				busy.current = false;
				if (mounted.current) setBusyValue(null);
			}
		},
		[selected, target, refresh]
	);

	const current = showCurrent ? (selected?.current_input ?? null) : null;
	const rows = useMemo(
		() =>
			selected ? monitorInputRows({ discovered: selected.supported, spec: sources, current }) : [],
		[selected, sources, current]
	);
	const title = label?.trim() || selected?.friendly || 'Monitor';
	const stats = selected
		? formatStats({
				width: selected.width,
				height: selected.height,
				refreshHz: selected.refresh_hz
			})
		: '';

	return (
		<MonitorSwitch
			title={title}
			rows={rows}
			stats={stats}
			showStats={showStats}
			busyValue={busyValue}
			missing={missing}
			loading={loading}
			unavailable={!loading && !missing && selected === null}
			compact={compact}
			onPick={pick}
			color={color}
		/>
	);
}
