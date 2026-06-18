// Studio Inspector editor for the Monitor Switch widget's `sources` config. Replaces the raw hex spec
// with a friendly checklist: it detects the chosen monitor's inputs (DDC/CI) and lets you pick which to
// show and rename each (e.g. "HDMI 2" → "Switch 2"). It reads/writes the same `code=label` spec string
// the widget already consumes (core/monitorInputs `sourceEditorRows` / `buildSourceSpec`), so the
// stored config is unchanged. Studio-only (it calls a Tauri command); degrades to a plain text field
// when no inputs can be detected (DDC/CI off, dev mock, or a monitor that doesn't report them).
import { useCallback, useEffect, useState } from 'react';
import { listMonitorInputs } from '../../ddc/monitors';
import { buildSourceSpec, sourceEditorRows, type SourceEditorRow } from '../../core/monitorInputs';
import './MonitorSourcesEditor.css';

type Props = {
	value: string; // current `sources` spec (code=label, comma-separated)
	monitor: string; // configured GDI device name ('' = the primary monitor)
	onChange: (spec: string) => void;
};

export default function MonitorSourcesEditor({ value, monitor, onChange }: Props) {
	const [detected, setDetected] = useState<number[]>([]);
	const [loading, setLoading] = useState(true);

	const scan = useCallback(async (): Promise<void> => {
		setLoading(true);
		const list = await listMonitorInputs(monitor || undefined);
		const target = monitor
			? list.find((m) => m.gdi === monitor)
			: list.find((m) => m.primary) ?? list[0];
		setDetected(target?.supported ?? []);
		setLoading(false);
	}, [monitor]);

	useEffect(() => {
		void scan();
	}, [scan]);

	const rows = sourceEditorRows(detected, value);
	const emit = (next: SourceEditorRow[]): void => onChange(buildSourceSpec(next));
	const toggle = (i: number): void =>
		emit(rows.map((r, j) => (j === i ? { ...r, include: !r.include } : r)));
	// Commas/newlines are the spec's separators, so strip them from a label to keep it parseable.
	const rename = (i: number, label: string): void =>
		emit(rows.map((r, j) => (j === i ? { ...r, label: label.replace(/[,\n]/g, ' ') } : r)));

	return (
		<div className="ms-src-editor">
			<div className="ms-src-head">
				<span className="ms-src-status">
					{loading ? 'detecting inputs…' : `${rows.length} input${rows.length === 1 ? '' : 's'}`}
				</span>
				<button
					type="button"
					className="ms-src-scan"
					onClick={() => void scan()}
					disabled={loading}
				>
					rescan
				</button>
			</div>
			{rows.length === 0 ? (
				<div className="ms-src-empty">
					No inputs detected — DDC/CI may be off in the monitor’s menu, or it doesn’t report them.
					Enter codes manually, e.g. <code>0x11=Desktop, 0x12=Switch</code>:
					<input
						type="text"
						value={value}
						placeholder="0x11=Desktop, 0x12=Switch"
						onChange={(e) => onChange(e.currentTarget.value)}
					/>
				</div>
			) : (
				<ul className="ms-src-rows">
					{rows.map((r, i) => (
						<li key={r.value} className="ms-src-row" data-off={!r.include || undefined}>
							<label className="ms-src-check">
								<input type="checkbox" checked={r.include} onChange={() => toggle(i)} />
								<span className="ms-src-name">
									{r.defaultName}
									{r.detected ? '' : ' (manual)'}
								</span>
							</label>
							<input
								type="text"
								className="ms-src-label"
								value={r.label}
								placeholder={r.defaultName}
								disabled={!r.include}
								onChange={(e) => rename(i, e.currentTarget.value)}
							/>
						</li>
					))}
				</ul>
			)}
		</div>
	);
}
