import { useEffect, useRef, useState } from 'react';
import WidgetPreview from './WidgetPreview';
import type { LayoutNode } from '../core/layoutTree';

/** Only visible tiles render live specimens; offscreen meters release their timers. */
export default function PalettePreview({
	type,
	node,
	size
}: {
	type?: string;
	node?: LayoutNode;
	size?: { w: number; h: number };
}) {
	const ref = useRef<HTMLSpanElement>(null);
	const [visible, setVisible] = useState(false);
	const [width, setWidth] = useState(120);
	useEffect(() => {
		const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting));
		observer.observe(ref.current!);
		const resize = new ResizeObserver(([entry]) =>
			setWidth(Math.max(64, Math.floor(entry.contentRect.width) - 16))
		);
		resize.observe(ref.current!);
		return () => {
			observer.disconnect();
			resize.disconnect();
		};
	}, []);
	return (
		<span ref={ref} className="catalog-preview" aria-hidden="true" inert>
			{visible && <WidgetPreview type={type} node={node} size={size} w={width} h={100} />}
		</span>
	);
}
