/** Kitchen timer sweep: 0 at bottom-left, 30 at top, 60 at bottom-right. */
export function dialMinutes(x: number, y: number, previous?: number): number {
	if (x === 0 && y === 0) return previous ?? 0;
	let angle = (Math.atan2(x, -y) * 180) / Math.PI;
	if (previous !== undefined) {
		const prior = previous * 5 - 150;
		if (angle - prior > 180) angle -= 360;
		if (angle - prior < -180) angle += 360;
	}
	return Math.round((Math.max(-150, Math.min(150, angle)) + 150) / 5);
}
