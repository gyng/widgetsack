// A reusable "add a token → removable chip" field for settings panels that collect a LIST of short
// strings (stock tickers, MQTT topics, …) — a structured replacement for the raw textareas those
// panels used, mirroring the editable-list affordance NowPlaying already has. Presentational: it owns
// only the pending-input text; the committed list lives in the parent (controlled `values`/`onChange`).
//
// `parse` turns a raw entry (a typed token OR a pasted blob) into 0+ normalised tokens — each panel
// passes its own splitter (stocks splits on newline/comma + upper-cases; MQTT splits on newline only,
// since topics may contain commas). Adds dedupe against the existing list, so paste-a-list just works.
import { useState } from 'react';

type Props = {
	label: React.ReactNode;
	values: string[];
	onChange: (next: string[]) => void;
	/** Split + normalise a raw entry/paste into tokens (already trimmed/cased; may contain dupes). */
	parse: (raw: string) => string[];
	placeholder?: string;
	addLabel?: string;
	/** aria-label for the chip list (defaults to a string `label`). */
	listLabel?: string;
	/** Shown when the list is empty. */
	emptyHint?: string;
};

export default function TokenListField({
	label,
	values,
	onChange,
	parse,
	placeholder,
	addLabel = 'Add',
	listLabel,
	emptyHint
}: Props) {
	const [pending, setPending] = useState('');

	// Add every fresh token `raw` parses to (skipping ones already present), then clear the input.
	const commit = (raw: string) => {
		const tokens = parse(raw);
		if (tokens.length === 0) return;
		const next = values.slice();
		for (const t of tokens) if (!next.includes(t)) next.push(t);
		if (next.length !== values.length) onChange(next);
		setPending('');
	};

	const remove = (token: string) => onChange(values.filter((v) => v !== token));

	return (
		<div className="has-field">
			<span>{label}</span>
			{values.length > 0 ? (
				<ul
					className="has-tokens"
					aria-label={listLabel ?? (typeof label === 'string' ? label : undefined)}
				>
					{values.map((v) => (
						<li key={v} className="has-token">
							<span className="has-token-text" title={v}>
								{v}
							</span>
							<button
								type="button"
								className="has-token-x"
								title={`Remove ${v}`}
								aria-label={`Remove ${v}`}
								onClick={() => remove(v)}
							>
								×
							</button>
						</li>
					))}
				</ul>
			) : (
				emptyHint && <div className="has-help">{emptyHint}</div>
			)}
			<div className="has-token-add">
				<input
					type="text"
					value={pending}
					placeholder={placeholder}
					spellCheck={false}
					aria-label={typeof label === 'string' ? `Add ${label}` : 'Add item'}
					onChange={(e) => setPending(e.currentTarget.value)}
					onKeyDown={(e) => {
						if (e.key === 'Enter') {
							e.preventDefault();
							commit(pending);
						}
					}}
					onPaste={(e) => {
						// Intercept a "list" paste (contains a separator) so it fans out into chips; a single
						// token paste falls through to the input for the user to review and Add.
						const text = e.clipboardData.getData('text');
						if (/[\n,]/.test(text)) {
							e.preventDefault();
							commit(text);
						}
					}}
				/>
				<button
					type="button"
					onClick={() => commit(pending)}
					disabled={parse(pending).length === 0}
				>
					{addLabel}
				</button>
			</div>
		</div>
	);
}
