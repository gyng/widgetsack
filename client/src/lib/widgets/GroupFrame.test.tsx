import { beforeAll, describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import GroupFrame from './GroupFrame';

// happy-dom doesn't implement pointer capture; stub it so begin()'s setPointerCapture won't throw.
beforeAll(() => {
	Element.prototype.setPointerCapture = () => undefined;
});

const rect = { x: 10, y: 20, w: 100, h: 60 };
const box = (el: HTMLElement) => el.querySelector('[data-id="grp-1"]') as HTMLElement;
const overlay = (el: HTMLElement) => el.querySelector('.drag-overlay') as HTMLElement;

describe('GroupFrame', () => {
	it('renders its children inside one measurable, .widget-styled group box', () => {
		const { container, getByText } = render(
			<GroupFrame id="grp-1" rect={rect}>
				<span>inner</span>
			</GroupFrame>
		);
		expect(getByText('inner')).toBeTruthy();
		const b = box(container);
		expect(b.classList.contains('widget')).toBe(true);
		expect(b.classList.contains('floating-group')).toBe(true);
		expect(b.style.left).toBe('10px');
		expect(b.style.width).toBe('100px');
	});

	it('drags the whole group as one unit — move fires onChange(id), commit on release', () => {
		const onChange = vi.fn();
		const onCommit = vi.fn();
		const onSelect = vi.fn();
		const { container } = render(
			<GroupFrame
				id="grp-1"
				rect={rect}
				editMode
				selected
				onChange={onChange}
				onCommit={onCommit}
				onSelect={onSelect}
			/>
		);
		const ov = overlay(container);
		fireEvent.pointerDown(ov, { button: 0, pointerId: 1, clientX: 10, clientY: 10 });
		expect(onSelect).not.toHaveBeenCalled(); // deferred → a multi-selection survives the press
		fireEvent.pointerMove(ov, { pointerId: 1, clientX: 40, clientY: 10 }); // past DRAG_SLOP
		expect(onChange).toHaveBeenCalled();
		const arg = onChange.mock.calls.at(-1)?.[0] as { id: string; rect: { x: number } };
		expect(arg.id).toBe('grp-1');
		expect(arg.rect.x).toBeGreaterThan(rect.x); // moved right
		fireEvent.pointerUp(ov, { pointerId: 1, clientX: 40, clientY: 10 });
		expect(onCommit).toHaveBeenCalled();
		expect(onSelect).not.toHaveBeenCalled(); // a real drag never re-selects
	});

	it('selects on press when the group is not already selected', () => {
		const onSelect = vi.fn();
		const { container } = render(
			<GroupFrame id="grp-1" rect={rect} editMode onSelect={onSelect} />
		);
		fireEvent.pointerDown(overlay(container), {
			button: 0,
			pointerId: 1,
			clientX: 10,
			clientY: 10
		});
		expect(onSelect).toHaveBeenCalledWith({ id: 'grp-1' });
	});

	it('resizes via a handle — collapses selection on press, then onChange fires', () => {
		const onSelect = vi.fn();
		const onChange = vi.fn();
		const { container } = render(
			<GroupFrame
				id="grp-1"
				rect={rect}
				editMode
				selected
				onSelect={onSelect}
				onChange={onChange}
			/>
		);
		const handle = container.querySelector('.handle.se') as HTMLElement;
		fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 110, clientY: 80 });
		expect(onSelect).toHaveBeenCalledWith({ id: 'grp-1' }); // resize selects immediately (single unit)
		fireEvent.pointerMove(handle, { pointerId: 1, clientX: 140, clientY: 110 });
		expect(onChange).toHaveBeenCalled();
	});

	it('renders no edit overlay when not in edit mode (passive overlay)', () => {
		const { container } = render(<GroupFrame id="grp-1" rect={rect} />);
		expect(container.querySelector('.drag-overlay')).toBeNull();
		expect(container.querySelector('.handle')).toBeNull();
	});

	it('context menu in edit mode selects the group then opens the menu at the cursor', () => {
		const onSelect = vi.fn();
		const onContextMenu = vi.fn();
		const { container } = render(
			<GroupFrame
				id="grp-1"
				rect={rect}
				editMode
				onSelect={onSelect}
				onContextMenu={onContextMenu}
			/>
		);
		fireEvent.contextMenu(box(container), { clientX: 33, clientY: 44 });
		expect(onSelect).toHaveBeenCalledWith({ id: 'grp-1' });
		expect(onContextMenu).toHaveBeenCalledWith({ id: 'grp-1', x: 33, y: 44 });
	});

	it('context menu does nothing outside edit mode (passive overlay)', () => {
		const onContextMenu = vi.fn();
		const { container } = render(
			<GroupFrame id="grp-1" rect={rect} onContextMenu={onContextMenu} />
		);
		fireEvent.contextMenu(box(container));
		expect(onContextMenu).not.toHaveBeenCalled();
	});

	it('suppresses the context menu (and skips selection) when suppressContextMenu() is true', () => {
		const onSelect = vi.fn();
		const onContextMenu = vi.fn();
		const { container } = render(
			<GroupFrame
				id="grp-1"
				rect={rect}
				editMode
				onSelect={onSelect}
				onContextMenu={onContextMenu}
				suppressContextMenu={() => true}
			/>
		);
		fireEvent.contextMenu(box(container));
		expect(onSelect).not.toHaveBeenCalled();
		expect(onContextMenu).not.toHaveBeenCalled();
	});

	it('a press that never exceeds DRAG_SLOP is a click — no onChange, no commit', () => {
		const onChange = vi.fn();
		const onCommit = vi.fn();
		const onSelect = vi.fn();
		const { container } = render(
			<GroupFrame
				id="grp-1"
				rect={rect}
				editMode
				selected
				onChange={onChange}
				onCommit={onCommit}
				onSelect={onSelect}
			/>
		);
		const ov = overlay(container);
		fireEvent.pointerDown(ov, { button: 0, pointerId: 1, clientX: 10, clientY: 10 });
		fireEvent.pointerMove(ov, { pointerId: 1, clientX: 12, clientY: 11 }); // within DRAG_SLOP
		expect(onChange).not.toHaveBeenCalled();
		fireEvent.pointerUp(ov, { pointerId: 1, clientX: 12, clientY: 11 });
		expect(onCommit).not.toHaveBeenCalled();
		// A click (no drag) on an already-selected group collapses the multi-selection to just it.
		expect(onSelect).toHaveBeenCalledWith({ id: 'grp-1' });
	});

	it('subsequent moves after crossing the slop keep firing onChange (moved is latched)', () => {
		const onChange = vi.fn();
		const { container } = render(
			<GroupFrame id="grp-1" rect={rect} editMode selected onChange={onChange} />
		);
		const ov = overlay(container);
		fireEvent.pointerDown(ov, { button: 0, pointerId: 1, clientX: 10, clientY: 10 });
		fireEvent.pointerMove(ov, { pointerId: 1, clientX: 40, clientY: 10 }); // crosses the slop
		// back within the slop radius of the press: still a move — the gate only applies pre-drag
		fireEvent.pointerMove(ov, { pointerId: 1, clientX: 12, clientY: 10 });
		expect(onChange).toHaveBeenCalledTimes(2);
	});

	it('right-button press is a free-move (skipFlow): commit skips flow + suppresses the next menu', () => {
		const onChange = vi.fn();
		const onCommit = vi.fn();
		const onSuppressContextMenu = vi.fn();
		const { container } = render(
			<GroupFrame
				id="grp-1"
				rect={rect}
				editMode
				selected
				onChange={onChange}
				onCommit={onCommit}
				onSuppressContextMenu={onSuppressContextMenu}
			/>
		);
		const ov = overlay(container);
		fireEvent.pointerDown(ov, { button: 2, pointerId: 1, clientX: 10, clientY: 10 });
		fireEvent.pointerMove(ov, { pointerId: 1, clientX: 50, clientY: 10 }); // past DRAG_SLOP
		expect(onChange).toHaveBeenCalled();
		fireEvent.pointerUp(ov, { pointerId: 1, clientX: 50, clientY: 10 });
		expect(onCommit).toHaveBeenCalledWith({ skipFlow: true });
		expect(onSuppressContextMenu).toHaveBeenCalled();
	});

	it('right-button on a resize handle is ignored (free-move only applies to a move)', () => {
		const onChange = vi.fn();
		const onSelect = vi.fn();
		const { container } = render(
			<GroupFrame id="grp-1" rect={rect} editMode onChange={onChange} onSelect={onSelect} />
		);
		const handle = container.querySelector('.handle.se') as HTMLElement;
		fireEvent.pointerDown(handle, { button: 2, pointerId: 1, clientX: 110, clientY: 80 });
		fireEvent.pointerMove(handle, { pointerId: 1, clientX: 140, clientY: 110 });
		expect(onSelect).not.toHaveBeenCalled();
		expect(onChange).not.toHaveBeenCalled();
	});

	it('a middle-button press is reserved for panning — begin() bails, no select/change', () => {
		const onChange = vi.fn();
		const onSelect = vi.fn();
		const { container } = render(
			<GroupFrame id="grp-1" rect={rect} editMode onChange={onChange} onSelect={onSelect} />
		);
		const ov = overlay(container);
		fireEvent.pointerDown(ov, { button: 1, pointerId: 1, clientX: 10, clientY: 10 });
		fireEvent.pointerMove(ov, { pointerId: 1, clientX: 50, clientY: 10 });
		expect(onSelect).not.toHaveBeenCalled();
		expect(onChange).not.toHaveBeenCalled();
	});

	it('pointer events without any callbacks bound are no-ops (no throw)', () => {
		const { container } = render(<GroupFrame id="grp-1" rect={rect} editMode selected />);
		const ov = overlay(container);
		expect(() => {
			fireEvent.pointerDown(ov, { button: 0, pointerId: 1, clientX: 10, clientY: 10 });
			fireEvent.pointerMove(ov, { pointerId: 1, clientX: 50, clientY: 10 });
			fireEvent.pointerUp(ov, { pointerId: 1, clientX: 50, clientY: 10 });
		}).not.toThrow();
	});

	it('pointerMove/Up with no active drag are no-ops (action === null guard)', () => {
		const onChange = vi.fn();
		const onCommit = vi.fn();
		const { container } = render(
			<GroupFrame id="grp-1" rect={rect} editMode onChange={onChange} onCommit={onCommit} />
		);
		const ov = overlay(container);
		fireEvent.pointerMove(ov, { pointerId: 1, clientX: 50, clientY: 10 });
		fireEvent.pointerUp(ov, { pointerId: 1, clientX: 50, clientY: 10 });
		expect(onChange).not.toHaveBeenCalled();
		expect(onCommit).not.toHaveBeenCalled();
	});

	it('applies multi / highlighted modifier classes', () => {
		const { container } = render(
			<GroupFrame id="grp-1" rect={rect} editMode selected multi highlighted name="My Group" />
		);
		const b = box(container);
		expect(b.classList.contains('editable')).toBe(true);
		expect(b.classList.contains('selected')).toBe(true);
		expect(b.classList.contains('multi-member')).toBe(true);
		expect(b.classList.contains('hl')).toBe(true);
		// The move overlay uses the provided name in its aria-label.
		expect(overlay(container).getAttribute('aria-label')).toBe('Move My Group widget');
	});

	it('adds the .active class while a drag is in progress', () => {
		const { container } = render(<GroupFrame id="grp-1" rect={rect} editMode onChange={vi.fn()} />);
		const ov = overlay(container);
		expect(box(container).classList.contains('active')).toBe(false);
		fireEvent.pointerDown(ov, { button: 0, pointerId: 1, clientX: 10, clientY: 10 });
		expect(box(container).classList.contains('active')).toBe(true);
		fireEvent.pointerUp(ov, { pointerId: 1, clientX: 10, clientY: 10 });
		expect(box(container).classList.contains('active')).toBe(false);
	});

	it('fires onHover with the id on enter and null on leave', () => {
		const onHover = vi.fn();
		const { container } = render(<GroupFrame id="grp-1" rect={rect} onHover={onHover} />);
		fireEvent.mouseEnter(box(container));
		expect(onHover).toHaveBeenLastCalledWith('grp-1');
		fireEvent.mouseLeave(box(container));
		expect(onHover).toHaveBeenLastCalledWith(null);
	});
});
