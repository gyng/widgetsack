// Pure stat-list builder for the GPU panel: pick the metrics that are actually reported and format
// them. No React/DOM — unit-tested (gpu.test.ts). The meter extracts the raw values from its sensor
// map and renders the returned list. Units: vram bytes, temp °C, power W, clock MHz, fan %.
import { formatBytes } from './format';

export type GpuStat = { key: string; label: string; value: string };

const num = (x: number | null | undefined): x is number =>
	typeof x === 'number' && Number.isFinite(x);

/** The secondary GPU metrics (in order), skipping any not reported — AMD / no NVML / a metric NVML
 * doesn't expose on this card all just drop out, so the panel never shows blanks. */
export function gpuStats(v: {
	temp?: number | null;
	vramUsed?: number | null;
	vramTotal?: number | null;
	power?: number | null;
	clockCore?: number | null;
	fan?: number | null;
}): GpuStat[] {
	const out: GpuStat[] = [];
	if (num(v.temp)) out.push({ key: 'temp', label: 'temp', value: `${Math.round(v.temp)}°` });
	if (num(v.vramUsed) && num(v.vramTotal))
		out.push({
			key: 'vram',
			label: 'vram',
			value: `${formatBytes(v.vramUsed)} / ${formatBytes(v.vramTotal)}`
		});
	if (num(v.power)) out.push({ key: 'power', label: 'power', value: `${Math.round(v.power)} W` });
	if (num(v.clockCore))
		out.push({ key: 'clock', label: 'clock', value: `${Math.round(v.clockCore)} MHz` });
	if (num(v.fan)) out.push({ key: 'fan', label: 'fan', value: `${Math.round(v.fan)}%` });
	return out;
}
