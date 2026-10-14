// Interactive HA meter (molecule): a unified Home Assistant input-helper widget. It infers the
// helper kind from the entity's domain (read off the state's entity_id) and renders the matching
// control: input_boolean → toggle, input_button → press, input_select → dropdown, input_number →
// slider, input_text → text field. Each emits onControl with the right {domain, service, data}, which
// Canvas turns into ha_call_service. service_data is built by the pure core/haControls helpers.
import { useEffect, useState, type ReactNode } from 'react';
import {
	entityDomain,
	HA_HELD_MS,
	inputNumberSetValue,
	inputSelectOption,
	inputTextSetValue,
	type InputNumberAttrs
} from '../../core/haControls';
import type { ControlEvent } from '../meterProps';
import { haTileState } from '../../core/haTileState';
import HaTileNotice from './HaTileNotice';
import './HaControls.css';

type HaState = { entity_id?: string; state?: string; attributes?: Record<string, unknown> };

type Props = {
	value?: unknown;
	/** The `ha.status` sample (host-supplied): undefined = not wired, null = no status heard yet. */
	haStatus?: string | null;
	label?: string;
	onControl?: (e: ControlEvent) => void;
};

function HaTextInput({
	name,
	value,
	onCommit
}: {
	name: string;
	value: string;
	onCommit: (value: string) => void;
}) {
	const [draft, setDraft] = useState(value);
	// The last value known to match the entity (its state, or what we last sent).
	const [submitted, setSubmitted] = useState(value);
	const [focused, setFocused] = useState(false);
	// Follow server changes only while the field is idle: a focused or dirty field keeps the user's text.
	const [prevValue, setPrevValue] = useState(value);
	if (value !== prevValue) {
		setPrevValue(value);
		if (!focused && draft === submitted) {
			setDraft(value);
			setSubmitted(value);
		}
	}

	const commit = (): boolean => {
		if (draft === submitted) return false;
		setSubmitted(draft);
		onCommit(draft);
		return true;
	};

	return (
		<input
			type="text"
			className="hi-text"
			data-part="text"
			value={draft}
			aria-label={`${name} value`}
			onChange={(event) => setDraft(event.currentTarget.value)}
			onFocus={() => setFocused(true)}
			onKeyDown={(event) => {
				if (event.key !== 'Enter') return;
				commit();
			}}
			onBlur={() => {
				setFocused(false);
				// Nothing to send → catch up with whatever the entity reported while focused.
				if (!commit()) {
					setDraft(value);
					setSubmitted(value);
				}
			}}
		/>
	);
}

/** An input_number slider that drags a LOCAL draft and sends one set_value on release (pointer up,
 * key up, blur), then shows the sent value until the entity state changes. */
function HaNumberInput({
	name,
	state,
	attrs,
	onCommit
}: {
	name: string;
	state: string;
	attrs: InputNumberAttrs;
	onCommit: (value: number) => void;
}) {
	const num = Number(state);
	const current = Number.isFinite(num) ? num : (attrs.min ?? 0);
	const [local, setLocal] = useState<{ value: number; sent: boolean } | null>(null);
	// A sent value is held until the entity reports a new state; an unsent drag survives any echo.
	const [prevState, setPrevState] = useState(state);
	if (state !== prevState) {
		setPrevState(state);
		if (local?.sent) setLocal(null);
	}
	// A call that failed (or that HA ignored) never changes the state: let the slider snap back.
	useEffect(() => {
		if (!local?.sent) return;
		const t = setTimeout(() => setLocal(null), HA_HELD_MS);
		return () => clearTimeout(t);
	}, [local]);
	const shown = local?.value ?? current;
	const commit = (): void => {
		if (!local || local.sent) return;
		setLocal({ value: local.value, sent: true });
		if (local.value !== current) onCommit(local.value);
	};
	return (
		<>
			<span className="hi-num" data-part="value">
				{local ? String(local.value) : state}
			</span>
			<input
				type="range"
				className="hi-range"
				data-part="number"
				min={attrs.min ?? 0}
				max={attrs.max ?? 100}
				step={attrs.step ?? 1}
				value={shown}
				aria-label={`${name} value`}
				onChange={(e) => setLocal({ value: Number(e.currentTarget.value), sent: false })}
				onPointerUp={commit}
				onLostPointerCapture={commit}
				onKeyUp={commit}
				onBlur={commit}
			/>
		</>
	);
}

export default function HaInput({ value = null, haStatus, label, onControl }: Props) {
	const s = (value ?? null) as HaState | null;
	const attrs = (s?.attributes ?? {}) as Record<string, unknown>;
	const name = label ?? (attrs.friendly_name as string | undefined) ?? 'Input';
	const domain = entityDomain(s?.entity_id);
	const state = s?.state ?? '';
	// `emit` is only called from a branch that matched a concrete input_* domain below.
	const emit = (service: string, data?: Record<string, unknown>): void =>
		onControl?.({ domain, service, ...(data ? { data } : {}) });

	let control: ReactNode;
	if (domain === 'input_boolean') {
		const on = state === 'on';
		control = (
			<button
				type="button"
				className={`hi-toggle${on ? ' on' : ''}`}
				data-part="toggle"
				aria-pressed={on}
				onClick={() => emit('toggle')}
			>
				{on ? 'ON' : 'OFF'}
			</button>
		);
	} else if (domain === 'input_button') {
		control = (
			<button type="button" className="hi-press" data-part="press" onClick={() => emit('press')}>
				Press
			</button>
		);
	} else if (domain === 'input_select') {
		const advertised = (attrs.options as string[] | undefined) ?? [];
		const options = state && !advertised.includes(state) ? [state, ...advertised] : advertised;
		control = (
			<select
				className="hi-select"
				data-part="select"
				value={state}
				aria-label={`${name} option`}
				onChange={(e) => {
					const c = inputSelectOption(e.currentTarget.value);
					emit(c.service, c.data);
				}}
			>
				{options.map((o) => (
					<option key={o} value={o}>
						{o}
					</option>
				))}
			</select>
		);
	} else if (domain === 'input_number') {
		const a = attrs as InputNumberAttrs;
		control = (
			<HaNumberInput
				name={name}
				state={state}
				attrs={a}
				onCommit={(value) => {
					const c = inputNumberSetValue(value, a);
					emit(c.service, c.data);
				}}
			/>
		);
	} else if (domain === 'input_text') {
		control = (
			<HaTextInput
				name={name}
				value={state}
				onCommit={(value) => {
					const c = inputTextSetValue(value);
					emit(c.service, c.data);
				}}
			/>
		);
	} else {
		control = (
			<span className="value" data-part="value">
				{state}
			</span>
		);
	}

	// No live data (plugin unset / offline / entity unavailable / still waiting) → the shared notice.
	const tile = haTileState(haStatus, value);
	if (tile.kind !== 'ok')
		return <HaTileNotice className="ha-input np-ha-input" label={name} tile={tile} />;

	return (
		<div className="ha-input np-ha-input" data-part="root">
			<span className="label" data-part="label">
				{name}
			</span>
			{control}
		</div>
	);
}
