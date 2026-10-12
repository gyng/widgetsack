import { useEffect, useRef, useState } from 'react';

/** Keep catalog rows mounted, but request values only while they intersect their scroll viewport. */
export function useSensorRowVisibility() {
	const ref = useRef<HTMLDivElement>(null);
	const [visible, setVisible] = useState(() => typeof IntersectionObserver === 'undefined');
	useEffect(() => {
		if (typeof IntersectionObserver === 'undefined') return;
		let alive = true;
		const observer = new IntersectionObserver((entries) => {
			if (alive) setVisible(entries.some((entry) => entry.isIntersecting));
		});
		// The ref belongs to the row rendered by SensorRow; it is attached before this effect runs.
		observer.observe(ref.current!);
		return () => {
			alive = false;
			observer.disconnect();
		};
	}, []);
	return { ref, visible };
}
