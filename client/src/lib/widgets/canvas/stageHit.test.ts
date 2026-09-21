import { describe, expect, it } from 'vitest';
import { isEmptyStagePress } from './stageHit';

// Build a studio-shaped DOM: .canvas > .world > .flow-frame > [data-id root] > (widget | grid-cell …),
// plus a docked panel. Returns the elements a press can land on.
function stage() {
	const canvas = document.createElement('div');
	canvas.className = 'canvas studio edit';
	const world = document.createElement('div');
	world.className = 'world scaled';
	const frame = document.createElement('div');
	frame.className = 'flow-frame';
	const root = document.createElement('div');
	root.setAttribute('data-id', 'root');
	const widget = document.createElement('div');
	widget.className = 'widget flow';
	const overlay = document.createElement('button');
	overlay.className = 'drag-overlay';
	widget.append(overlay);
	const cell = document.createElement('button');
	cell.className = 'grid-cell';
	const splitter = document.createElement('div');
	splitter.className = 'splitter v';
	const tag = document.createElement('button');
	tag.className = 'ctag';
	const inspector = document.createElement('div');
	inspector.className = 'inspector';
	const field = document.createElement('input');
	inspector.append(field);
	root.append(widget, cell);
	frame.append(root);
	world.append(frame, splitter, tag);
	canvas.append(world, inspector);
	document.body.append(canvas);
	return { canvas, world, frame, root, widget, overlay, cell, splitter, tag, inspector, field };
}

describe('isEmptyStagePress', () => {
	it('is on-canvas for the stage, the world, the flow frame and the root FlowNode div', () => {
		const s = stage();
		// The root FlowNode div + the flow frame cover the whole monitor: a press INSIDE the monitor
		// lands on one of them, and must still count as empty canvas (the marquee bug).
		expect(isEmptyStagePress(s.canvas)).toBe(true);
		expect(isEmptyStagePress(s.world)).toBe(true);
		expect(isEmptyStagePress(s.frame)).toBe(true);
		expect(isEmptyStagePress(s.root)).toBe(true);
		s.canvas.remove();
	});

	it('is NOT on-canvas inside a widget, grid cell, splitter, container tag or docked panel', () => {
		const s = stage();
		expect(isEmptyStagePress(s.widget)).toBe(false);
		expect(isEmptyStagePress(s.overlay)).toBe(false); // a descendant of the widget
		expect(isEmptyStagePress(s.cell)).toBe(false);
		expect(isEmptyStagePress(s.splitter)).toBe(false);
		expect(isEmptyStagePress(s.tag)).toBe(false);
		expect(isEmptyStagePress(s.inspector)).toBe(false);
		expect(isEmptyStagePress(s.field)).toBe(false);
		s.canvas.remove();
	});

	it('is NOT on-canvas for a null / non-element / off-stage target', () => {
		expect(isEmptyStagePress(null)).toBe(false);
		expect(isEmptyStagePress(document.createTextNode('x'))).toBe(false);
		expect(isEmptyStagePress(document.createElement('div'))).toBe(false); // outside any .canvas
	});
});
