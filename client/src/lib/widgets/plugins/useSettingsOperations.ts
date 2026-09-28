import { useCallback, useEffect, useRef, useState } from 'react';

/** Own async feedback for one editable settings form. Work may finish after an edit,
 * but only results for the current revision may change the form or its feedback. */
export function useSettingsOperations() {
	const revision = useRef(0);
	const alive = useRef(true);
	const busy = useRef(false);
	const requests = useRef(new Map<string, number>());
	const [saving, setSaving] = useState(false);
	const [saved, setSaved] = useState(false);
	const [error, setError] = useState<string | null>(null);
	useEffect(() => {
		alive.current = true;
		return () => {
			alive.current = false;
		};
	}, []);
	useEffect(() => {
		if (!saved) return;
		const timer = setTimeout(() => setSaved(false), 2500);
		return () => clearTimeout(timer);
	}, [saved]);
	const capture = useCallback(() => {
		const at = revision.current;
		return () => alive.current && revision.current === at;
	}, []);
	const invalidate = useCallback(() => {
		revision.current++;
		setSaved(false);
		setError(null);
	}, []);
	const save = useCallback(
		async <T>(work: () => Promise<T>, apply?: (value: T) => void): Promise<void> => {
			if (busy.current || !alive.current) return;
			busy.current = true;
			setSaving(true);
			setSaved(false);
			setError(null);
			// A save also invalidates any earlier initial-load/test result.
			revision.current++;
			const current = capture();
			try {
				const value = await work();
				if (current()) {
					apply?.(value);
					setSaved(true);
				}
			} catch (err) {
				if (current()) setError(err instanceof Error ? err.message : String(err));
			} finally {
				busy.current = false;
				if (alive.current) setSaving(false);
			}
		},
		[capture]
	);
	const latest = useCallback(
		async <T>(
			key: string,
			work: () => Promise<T>,
			apply: (value: T) => void,
			failed?: (error: unknown) => void
		): Promise<void> => {
			const request = (requests.current.get(key) ?? 0) + 1;
			requests.current.set(key, request);
			const validRevision = capture();
			const current = () => validRevision() && requests.current.get(key) === request;
			try {
				const value = await work();
				if (current()) apply(value);
			} catch (err) {
				if (current()) failed?.(err);
			}
		},
		[capture]
	);
	return { saving, saved, error, capture, invalidate, save, latest };
}
