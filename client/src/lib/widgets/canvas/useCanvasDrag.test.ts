import { act, renderHook } from '@testing-library/react';
import { useRef, useLayoutEffect } from 'react';
import { describe, expect, it } from 'vitest';
import { useCanvasDrag } from './useCanvasDrag';
import { useEditorModel } from './useEditorModel';
import { container, leaf } from '../../core/layoutTree';
import { createWidget } from '../../core/widget';
import type { Renderable, Solved } from '../../core/solve';

function useDrag() {
	const widget = createWidget('text', 'floating');
	const model = useEditorModel(true, [leaf(widget)]);
	const monitorForDragRef = useRef(model.state.monitor);
	useLayoutEffect(() => {
		monitorForDragRef.current = model.state.monitor;
	}, [model.state.monitor]);
	const drag = useCanvasDrag({
		monitorForDragRef,
		solvedRef: useRef<Solved>(new Map([['root', { x: 0, y: 0, w: 500, h: 500 }]])),
		renderablesRef: useRef<Renderable[]>([]),
		selectedIdsRef: useRef<string[]>([]),
		toWorld: (x, y) => ({ x, y }),
		toCanvas: (x, y) => ({ x, y }),
		floatingGroupBox: () => widget.rect,
		translateSelectedFloating: () => false,
		commitOp: model.commitOp,
		mutateNoSave: model.mutateNoSave
	});
	return { ...drag, model };
}
describe('canvas gesture lifecycle', () => {
	it('commits a series of live changes as one undo step and clears feedback', () => {
		const { result } = renderHook(useDrag);
		act(() => result.current.model.dispatch({ type: 'resetHistory' }));
		for (const x of [30, 60, 90])
			act(() => result.current.onChange({ id: 'floating', rect: { x, y: 30, w: 100, h: 40 } }));
		expect(result.current.model.state.undoStack).toHaveLength(0);
		act(() => result.current.onCommit());
		expect(result.current.model.state.undoStack).toHaveLength(1);
		expect(result.current.guideXs).toEqual([]);
		act(() => result.current.model.dispatch({ type: 'undo' }));
		expect(result.current.model.state.monitor.floating[0].unit).toMatchObject({ rect: { x: 24 } });
	});
	it('cancels a flow ghost without committing and clears its drop target before another gesture', () => {
		const { result } = renderHook(useDrag);
		act(() =>
			result.current.model.dispatch({
				type: 'load',
				patch: {
					monitor: {
						root: container('root', 'col', [leaf(createWidget('text', 'flow'))]),
						floating: result.current.model.state.monitor.floating
					}
				}
			})
		);
		act(() => result.current.onDragOver({ id: 'flow', x: 100, y: 100 }));
		expect(result.current.dragHint).not.toBeNull();
		act(() => result.current.onCancel({ commit: false }));
		expect(result.current.dragHint).toBeNull();
		expect(result.current.dropZone).toBeNull();
		expect(result.current.model.state.saveSeq).toBe(0);
		act(() => result.current.onCommit());
		expect(result.current.model.state.monitor.floating).toHaveLength(1);
	});
	it('keeps applied floating movement on cancel without docking at the last hovered target', () => {
		const { result } = renderHook(useDrag);
		act(() => result.current.model.dispatch({ type: 'resetHistory' }));
		act(() => result.current.onChange({ id: 'floating', rect: { x: 80, y: 80, w: 100, h: 40 } }));
		act(() => result.current.onDragOver({ id: 'floating', x: 100, y: 100 }));
		act(() => result.current.onCancel({ commit: true }));
		expect(result.current.model.state.monitor.floating[0].unit).toMatchObject({ rect: { x: 80 } });
		expect(result.current.model.state.undoStack).toHaveLength(1);
		expect(result.current.dragHint).toBeNull();
	});
});
