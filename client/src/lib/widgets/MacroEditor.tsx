// Inspector control for a `kind:'macro'` config field: edit an ordered list of {domain, service,
// data?} action calls run in sequence on press. Controlled (value + onChange) and prop-only — the
// immutable edit ops live in core/macro.ts; this just wires them to row inputs. `domain`/`service`
// are plain text with native <datalist> autocomplete of common values; an entity picker (also a
// datalist, fed the HA catalog) writes `data.entity_id` for the common case, while `data` stays an
// editable JSON escape hatch for everything else (committed on blur so partial JSON never clobbers
// the field). Styled by Inspector.css (it only ever renders inside the inspector).
import { useState } from 'react';
import {
	addAction,
	moveAction,
	removeAction,
	updateAction,
	withEntityId,
	type Macro,
	type MacroAction
} from '../core/macro';

type Props = {
	value: Macro;
	onChange: (next: Macro) => void;
	// HA entity ids (e.g. "light.kitchen") for the entity-picker datalist; empty/absent → free text.
	entities?: string[];
};

// Autocomplete suggestions — the inputs stay free text, these are just hints. Covers the HA control
// family + the built-in `media` (now-playing) domain.
const DOMAIN_SUGGESTIONS = [
	'light',
	'switch',
	'fan',
	'cover',
	'lock',
	'climate',
	'media_player',
	'scene',
	'script',
	'automation',
	'input_boolean',
	'input_number',
	'input_select',
	'input_button',
	'vacuum',
	'media'
];
const SERVICE_SUGGESTIONS = [
	'toggle',
	'turn_on',
	'turn_off',
	'trigger',
	'press',
	'select_option',
	'set_value',
	'set_temperature',
	'set_hvac_mode',
	'set_fan_mode',
	'set_percentage',
	'open_cover',
	'close_cover',
	'stop_cover',
	'set_cover_position',
	'lock',
	'unlock',
	'volume_set',
	'volume_mute',
	'media_play_pause',
	'media_next_track',
	'media_previous_track',
	'playpause',
	'next',
	'previous'
];

const dataToText = (data: Record<string, unknown> | undefined): string =>
	data ? JSON.stringify(data) : '';

export default function MacroEditor({ value, onChange, entities = [] }: Props) {
	const actions = value ?? [];
	return (
		<div className="macro-editor">
			{/* Shared datalists referenced by every row's inputs (one per document; only one MacroEditor
			    renders at a time — for the selected widget). */}
			<datalist id="macro-domains">
				{DOMAIN_SUGGESTIONS.map((d) => (
					<option key={d} value={d} />
				))}
			</datalist>
			<datalist id="macro-services">
				{SERVICE_SUGGESTIONS.map((s) => (
					<option key={s} value={s} />
				))}
			</datalist>
			<datalist id="macro-entities">
				{entities.map((e) => (
					<option key={e} value={e} />
				))}
			</datalist>

			{actions.length === 0 ? (
				<div className="macro-empty">No actions — the button is inert until you add one.</div>
			) : null}
			{actions.map((a, i) => (
				<MacroRow
					// Keyed by index + data identity so a reorder (which changes the data at this slot)
					// re-mounts the row and re-seeds its local data/entity buffers from props.
					key={`${i}:${dataToText(a.data)}`}
					action={a}
					first={i === 0}
					last={i === actions.length - 1}
					onPatch={(patch) => onChange(updateAction(actions, i, patch))}
					onUp={() => onChange(moveAction(actions, i, -1))}
					onDown={() => onChange(moveAction(actions, i, 1))}
					onRemove={() => onChange(removeAction(actions, i))}
				/>
			))}
			<button type="button" className="macro-add" onClick={() => onChange(addAction(actions))}>
				+ action
			</button>
		</div>
	);
}

function MacroRow({
	action,
	first,
	last,
	onPatch,
	onUp,
	onDown,
	onRemove
}: {
	action: MacroAction;
	first: boolean;
	last: boolean;
	onPatch: (patch: Partial<MacroAction>) => void;
	onUp: () => void;
	onDown: () => void;
	onRemove: () => void;
}) {
	const [dataText, setDataText] = useState(dataToText(action.data));
	const [dataError, setDataError] = useState(false);
	// Local buffer so typing an entity doesn't re-write `data` (and remount the row) on every keystroke;
	// committed on blur, like the JSON field.
	const [entityText, setEntityText] = useState(
		(action.data?.entity_id as string | undefined) ?? ''
	);

	// Commit the data field: empty clears `data`; a JSON object sets it; anything else flags an error
	// and leaves the committed value untouched (the text stays so the user can fix it).
	const commitData = () => {
		const t = dataText.trim();
		if (t === '') {
			setDataError(false);
			onPatch({ data: undefined });
			return;
		}
		try {
			const parsed = JSON.parse(t) as unknown;
			if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
				setDataError(true);
				return;
			}
			setDataError(false);
			onPatch({ data: parsed as Record<string, unknown> });
		} catch {
			setDataError(true);
		}
	};

	const commitEntity = () => onPatch({ data: withEntityId(action.data, entityText) });

	return (
		<div className="macro-row">
			<div className="macro-row-main">
				<input
					className="macro-domain"
					placeholder="domain"
					list="macro-domains"
					title="domain — e.g. light, switch, scene, script, or media"
					value={action.domain}
					onChange={(e) => onPatch({ domain: e.currentTarget.value })}
				/>
				<input
					className="macro-service"
					placeholder="service"
					list="macro-services"
					title="service — e.g. toggle, turn_on; for media: playpause, next, previous"
					value={action.service}
					onChange={(e) => onPatch({ service: e.currentTarget.value })}
				/>
				<div className="macro-row-ops">
					<button type="button" title="Move up" disabled={first} onClick={onUp}>
						↑
					</button>
					<button type="button" title="Move down" disabled={last} onClick={onDown}>
						↓
					</button>
					<button
						type="button"
						className="x"
						title="Remove action"
						aria-label="Remove action"
						onClick={onRemove}
					>
						✕
					</button>
				</div>
			</div>
			<input
				className="macro-entity"
				placeholder="entity (optional), e.g. light.kitchen"
				list="macro-entities"
				title="target entity — picks from your HA entities; sets data.entity_id"
				value={entityText}
				onChange={(e) => setEntityText(e.currentTarget.value)}
				onBlur={commitEntity}
			/>
			<input
				className={dataError ? 'macro-data error' : 'macro-data'}
				placeholder='extra data (JSON), e.g. {"brightness_pct":60}'
				title="optional JSON args merged with the entity above (brightness, temperature, …)"
				value={dataText}
				onChange={(e) => setDataText(e.currentTarget.value)}
				onBlur={commitData}
			/>
		</div>
	);
}
