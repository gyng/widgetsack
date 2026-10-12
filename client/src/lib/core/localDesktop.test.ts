import { expect, it } from 'vitest';
import { isContainer, isGroup, type LayoutNode } from './layoutTree';
import { LOCAL_DESKTOP_DEF, localDesktopMonitor, localDesktopPreset } from './localDesktop';
import { unpackLayout } from './savedLayout';

it('ships the local arrangement with dynamic CPU charts, automatic monitor inputs, and no library dependency', () => {
	const first = localDesktopMonitor();
	const other = localDesktopMonitor();
	const types: string[] = [];
	function visit(node: LayoutNode) {
		if (isContainer(node)) return node.children.forEach(visit);
		if (isGroup(node.unit)) {
			expect(node.unit.def).toBeUndefined();
			return visit(node.unit.child);
		}
		types.push(node.unit.type);
		expect(node.unit.sensor?.startsWith('cpu.core.')).not.toBe(true);
		if (node.unit.type === 'cpu') expect(node.unit.config.mode).toBe('cores');
		if (node.unit.type === 'monitorswitch') {
			expect(node.unit.config.monitor).toBe('');
			expect(node.unit.config.sources).toBe('');
		}
	}
	visit(first.root);
	expect(types).toEqual(
		expect.arrayContaining(['cpu', 'clock', 'nowplaying', 'sparkline', 'monitorswitch'])
	);
	expect(unpackLayout(JSON.stringify(localDesktopPreset()))).not.toBeNull();
	first.root.children.splice(0);
	expect(other.root.children.length).toBeGreaterThan(0);
	expect(LOCAL_DESKTOP_DEF.size.w).toBeGreaterThan(0);
});
