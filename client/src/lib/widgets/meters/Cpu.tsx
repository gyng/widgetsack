// Self-sourcing CPU meter that toggles between a COMBINED view (a gauge of cpu.total) and a
// PER-CORE view (a grid of cpu.core.* sparklines — like the classic System skin's LINE meters).
// It reads the telemetry hub from context (provided by Canvas) rather than a single bound sensor,
// since it needs cpu.total AND every core. `binds: 'none'`. Composes Gauge + Sparkline.
import { useContext, useEffect, useState } from 'react';
import { TelemetryHubContext } from '../telemetryContext';
import Gauge from './Gauge';
import CpuCoresCanvas from './CpuCoresCanvas';
import './Cpu.css';

type Props = {
	mode?: 'combined' | 'cores';
	cols?: number;
	label?: string;
	color?: string;
	seconds?: number;
	histogram?: boolean;
	lineWidth?: number;
};

// Per-core USAGE ids only: `cpu.core.<n>`. The trailing `\d+$` deliberately EXCLUDES the per-core
// FREQUENCY ids (`cpu.core.<n>.freq`, in MHz) — the studio's "*" subscription broadcasts those to the
// overlay too, and on the 0–100% scale their thousands-of-MHz values plot off-screen as blank
// sparklines that pad the grid with empties.
const CORE_USAGE_ID = /^cpu\.core\.(\d+)$/;
// Called only after CORE_USAGE_ID filtering, so the suffix is known to be a decimal index.
const coreIndex = (id: string): number => Number(id.slice('cpu.core.'.length));

export default function Cpu({
	mode = 'cores',
	cols,
	label = 'CPU',
	color,
	seconds = 30,
	histogram = false,
	lineWidth
}: Props) {
	const hub = useContext(TelemetryHubContext);
	const [total, setTotal] = useState<number | null>(null);
	const [cores, setCores] = useState<number[][]>([]);

	// cpu.total + every core arrive in the same telemetry batch, so re-reading on each cpu.total tick
	// keeps both views fresh without managing a subscription per core.
	useEffect(() => {
		if (!hub) return;
		const readAll = (): void => {
			const t = hub.sensor('cpu.total').getSnapshot().value;
			setTotal(t && t.kind === 'scalar' ? t.value : null);
			const ids = hub
				.sensorIds()
				.filter((id) => CORE_USAGE_ID.test(id))
				.sort((a, b) => coreIndex(a) - coreIndex(b));
			setCores(ids.map((id) => hub.sensor(id).getSnapshot().history));
		};
		const unsub = hub.sensor('cpu.total').subscribe(readAll);
		readAll();
		return unsub;
	}, [hub]);

	if (mode === 'combined') {
		return <Gauge value={total} label={label} unit="%" min={0} max={100} color={color} />;
	}

	// Per-core grid drawn into a single <canvas> (not N SVG sparklines) — see CpuCoresCanvas for why
	// (the SVG-per-core grid leaks WebView2 native memory). `cols` defaults to 8 columns; the canvas
	// lays out the grid internally via coreCellRects (which clamps cols to the core count).
	return (
		<CpuCoresCanvas
			cores={cores}
			cols={cols != null && cols > 0 ? Math.round(cols) : 8}
			color={color}
			seconds={seconds}
			histogram={histogram}
			lineWidth={lineWidth ?? 1.5}
			fill={false}
		/>
	);
}
