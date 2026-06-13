// Curated list of well-known sensor ids the editor can suggest, plus a helper to
// merge them with whatever the telemetry hub has actually seen live (per-core CPU,
// GPU presence, etc.). Framework-agnostic, unit-tested.

// Curated, STABLE sensor ids (always offered in the picker). Dynamic ids — per-core cpu.core.N
// and per-drive disk.<letter>.* — are intentionally NOT listed here; they surface automatically
// via the live merge in sensorCatalog once the backend emits them (see sensorCatalog). The
// percent ids (mem.used/swap.used/gpu.vram) are kept for backward compat; the byte absolutes
// (mem.total, gpu.vram.used, …) are added alongside them. Mirrors widgetsack/src/sensors.rs.
export const KNOWN_SENSORS = [
	// CPU (cpu.core.N.freq is dynamic — surfaces via the live merge, like cpu.core.N)
	'cpu.total',
	'cpu.freq',
	'cpu.freq.current',
	'cpu.freq.max',
	'cpu.brand',
	'cpu.cores.logical',
	'cpu.cores.physical',
	// Memory (percent + absolute bytes; commit/cache/kernel are Windows-only)
	'mem.used',
	'mem.total',
	'mem.used.bytes',
	'mem.available',
	'mem.free',
	'mem.commit.used',
	'mem.commit.limit',
	'mem.commit.peak',
	'mem.cached',
	'mem.kernel.paged',
	'mem.kernel.nonpaged',
	// Swap / page file
	'swap.used',
	'swap.total',
	'swap.used.bytes',
	'swap.free',
	// Network (rates + cumulative; link/adapter are Windows-only)
	'net.down',
	'net.up',
	'net.total',
	'net.down.total',
	'net.up.total',
	'net.linkspeed.rx',
	'net.linkspeed.tx',
	'net.adapter',
	'net.state',
	// Active connections (gated; net.conn.list is a JSON sensor consumed by the Connections widget,
	// so it's not in the scalar picker — these totals are)
	'net.conn.established',
	'net.conn.listening',
	'net.conn.public',
	// Host (handles/threads/idle are Windows-only)
	'host.uptime',
	'host.procs',
	'host.idle',
	'host.handles',
	'host.threads',
	// Processes — the busiest + hungriest process (gated)
	'proc.cpu.top.name',
	'proc.cpu.top.pct',
	'proc.mem.top.name',
	'proc.mem.top.bytes',
	'proc.disk.top.name',
	'proc.disk.top.bytes',
	'proc.gpu.top.name',
	'proc.gpu.top.bytes',
	// GPU (NVIDIA / NVML)
	'gpu.util',
	'gpu.mem.util',
	'gpu.vram',
	'gpu.vram.total',
	'gpu.vram.used',
	'gpu.vram.free',
	'gpu.temp',
	'gpu.clock.core',
	'gpu.clock.mem',
	'gpu.power',
	'gpu.power.limit',
	'gpu.fan',
	'gpu.name',
	// Battery (laptops; emitted only when a battery is present)
	'battery.percent',
	'battery.state',
	'battery.time',
	'battery.rate',
	'battery.capacity.full',
	'battery.capacity.remaining'
];

/** Sorted, de-duped union of the curated list and the live sensor ids. */
export function sensorCatalog(live: string[]): string[] {
	return Array.from(new Set([...KNOWN_SENSORS, ...live])).sort();
}
