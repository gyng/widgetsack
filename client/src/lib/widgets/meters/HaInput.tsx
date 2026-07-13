// Interactive HA meter (molecule): a unified Home Assistant input-helper widget. It infers the
// helper kind from the entity's domain (read off the state's entity_id) and renders the matching
// control: input_boolean → toggle, input_button → press, input_select → dropdown, input_number →
// slider, input_text → text field. Each emits onControl with the right {domain, service, data}, which
// Canvas turns into ha_call_service. service_data is built by the pure core/haControls helpers.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
	entityDomain,
	inputNumberSetValue,
	inputSelectOption,
	inputTextSetValue,
	type InputNumberAttrs
} from '../../core/haControls';
import type { ControlEvent } from '../meterProps';
import './HaControls.css';

type HaState = { entity_id?: string; state?: string; attributes?: Record<string, unknown> };

type Props = {
	value?: unknown;
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
	const submitted = useRef(value);

	useEffect(() => {
		setDraft(value);
		submitted.current = value;
	}, [value]);

	const commit = (): void => {
		if (draft === submitted.current) return;
		submitted.current = draft;
		onCommit(draft);
	};

	return (
		<input
			type="text"
			className="hi-text"
			data-part="text"
			value={draft}
			aria-label={`${name} value`}
			onChange={(event) => setDraft(event.currentTarget.value)}
			onKeyDown={(event) => {
				if (event.key !== 'Enter') return;
				commit();
			}}
			onBlur={commit}
		/>
	);
}

export default function HaInput({ value = null, label, onControl }: Props) {
	const s = (value ?? null) as HaState | null;
	const attrs = (s?.attributes ?? {}) as Record<string, unknown>;
	const name = label ?? (attrs.friendly_name as string | undefined) ?? 'Input';
	const domain = entityDomain(s?.entity_id);
	const state = s?.state ?? '';
	// `domain` is always a concrete input_* here (emit is only called from the per-domain control
	// branches below, which render only when `domain` matched); the fallback is defensive belt only.
	const emit = (service: string, data?: Record<string, unknown>): void =>
		onControl?.({ domain: domain || 'input_boolean', service, ...(data ? { data } : {}) });

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
		const num = Number(state);
		control = (
			<input
				type="range"
				className="hi-range"
				data-part="number"
				min={a.min ?? 0}
				max={a.max ?? 100}
				step={a.step ?? 1}
				value={Number.isFinite(num) ? num : (a.min ?? 0)}
				aria-label={`${name} value`}
				onChange={(e) => {
					const c = inputNumberSetValue(Number(e.currentTarget.value), a);
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

	return (
		<div className="ha-input np-ha-input" data-part="root">
			<span className="label" data-part="label">
				{name}
			</span>
			{domain === 'input_number' ? (
				<span className="hi-num" data-part="value">
					{state}
				</span>
			) : null}
			{control}
		</div>
	);
}
