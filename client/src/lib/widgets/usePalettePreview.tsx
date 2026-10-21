import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { LayoutNode } from '../core/layoutTree';
import WidgetPreview from './WidgetPreview';
import './PaletteHoverPreview.css';

export type PalettePreviewSpec = {
	label: string;
	desc?: string;
	hint: string;
	type?: string;
	node?: LayoutNode;
	size?: { w: number; h: number };
};

/** One delayed sample-preview treatment for both the Layout catalog and Custom library. */
export function usePalettePreview(side: 'left' | 'right' = 'left') {
	const [preview, setPreview] = useState<
		(PalettePreviewSpec & { top: number; left: number }) | null
	>(null);
	const timer = useRef<number | null>(null);
	const ref = useRef<HTMLDivElement>(null);
	const showPreview = (spec: PalettePreviewSpec, el: HTMLElement) => {
		if (timer.current !== null) window.clearTimeout(timer.current);
		timer.current = window.setTimeout(() => {
			const r = el.getBoundingClientRect();
			const x = side === 'left' ? r.left - 260 : r.right + 12;
			setPreview({
				...spec,
				top: Math.max(8, r.top - 8),
				left: Math.max(8, Math.min(x, window.innerWidth - 256))
			});
		}, 280);
	};
	const hidePreview = useCallback(() => {
		if (timer.current !== null) {
			window.clearTimeout(timer.current);
			timer.current = null;
		}
		setPreview(null);
	}, []);
	useEffect(() => {
		const dismiss = (event: KeyboardEvent) => {
			if (event.key === 'Escape') hidePreview();
		};
		window.addEventListener('keydown', dismiss);
		return () => {
			window.removeEventListener('keydown', dismiss);
			if (timer.current !== null) window.clearTimeout(timer.current);
		};
	}, [hidePreview]);
	useLayoutEffect(() => {
		const el = ref.current;
		if (!el || !preview) return;
		el.style.top = `${Math.max(8, Math.min(preview.top, window.innerHeight - el.offsetHeight - 8))}px`;
	}, [preview]);
	return {
		showPreview,
		hidePreview,
		palettePreview: preview ? (
			<div
				ref={ref}
				className="palette-preview"
				role="tooltip"
				style={{ top: preview.top, left: preview.left }}
			>
				<div className="pp-stage" inert>
					<WidgetPreview type={preview.type} node={preview.node} size={preview.size} />
				</div>
				<div className="pp-meta">
					<span className="pp-name">{preview.label}</span>
					<span className="pp-sample-note">Sample preview</span>
					{preview.desc ? <span className="pp-desc">{preview.desc}</span> : null}
					<span className="pp-hint">{preview.hint}</span>
				</div>
			</div>
		) : null
	};
}
