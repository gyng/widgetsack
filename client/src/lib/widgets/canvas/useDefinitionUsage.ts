import { useEffect, useState } from 'react';
import { loadLayoutRaw, listLayouts, readLayout } from '../../bridge/layouts';
import { decodeLayoutDocument } from '../../core/layoutDocument';
import { unpackLayout } from '../../core/savedLayout';
import { definitionUsage } from '../../core/widgetUsage';
import { emptyMonitorLayout, type MonitorLayout, type Library } from '../../core/layoutTree';
import type { Extra } from '../../core/layoutPersistence';

type Sources = { id: string; layouts: Record<string, MonitorLayout>; incomplete: boolean };
/** Saved sources are a snapshot refreshed when the target changes; live edits and queued moves override it. */
export function useDefinitionUsage(
	id: string | null,
	monitorKey: string,
	desktop: MonitorLayout,
	library: Library | undefined,
	extras: readonly Extra[]
) {
	const [sources, setSources] = useState<Sources | null>(null);
	const [revision, setRevision] = useState(0);
	const [loading, setLoading] = useState(false);
	useEffect(() => {
		if (!id) return;
		let alive = true;
		setLoading(true);
		const read = async () => {
			const [document, names] = await Promise.allSettled([loadLayoutRaw(true), listLayouts(true)]);
			const layouts: Record<string, MonitorLayout> = {};
			let incomplete = document.status === 'rejected' || names.status === 'rejected';
			if (document.status === 'fulfilled') {
				const decoded = decodeLayoutDocument(document.value);
				if (decoded.kind === 'valid') Object.assign(layouts, decoded.layout.monitors);
				else if (decoded.kind === 'corrupt') incomplete = true;
			}
			if (names.status === 'fulfilled') {
				const profiles = await Promise.allSettled(
					names.value.map(async (name) => ({ name, raw: await readLayout(name) }))
				);
				for (const profile of profiles) {
					if (profile.status === 'rejected') {
						incomplete = true;
						continue;
					}
					const monitor = profile.value.raw ? unpackLayout(profile.value.raw) : null;
					if (monitor) layouts[`Saved: ${profile.value.name}`] = monitor;
					else incomplete = true;
				}
			}
			if (alive) {
				setSources({ id, layouts, incomplete });
				setLoading(false);
			}
		};
		void read();
		return () => {
			alive = false;
		};
	}, [id, monitorKey, revision]);
	const ready = sources?.id === id ? sources : null;
	const layouts = { ...ready?.layouts, [monitorKey]: desktop };
	for (const extra of extras) {
		const monitor = layouts[extra.key] ?? emptyMonitorLayout();
		layouts[extra.key] = {
			...monitor,
			floating: [...monitor.floating.filter((item) => item.id !== extra.leaf.id), extra.leaf]
		};
	}
	const locations = id ? definitionUsage(id, layouts, library) : [];
	const placements = locations.reduce((total, location) => total + location.count, 0);
	const label = !id
		? ''
		: !ready || loading
			? 'Checking widget usage…'
			: `${ready.incomplete ? 'Usage partly unavailable · ' : ''}Used in ${locations.length} layout${locations.length === 1 ? '' : 's'} · ${placements} placement${placements === 1 ? '' : 's'}`;
	return {
		locations,
		label,
		loading: !!id && (!ready || loading),
		refresh: () => setRevision((value) => value + 1)
	};
}
