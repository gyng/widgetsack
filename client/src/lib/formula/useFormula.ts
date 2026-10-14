// React glue between a widget's expr config fields and the sandboxed engine. Given a widget's expr
// fields + its config, it parses the formulas (pure, core/textTemplate), subscribes to ONLY the sensors
// they reference (useSensors), evaluates them in the QuickJS sandbox when ready, and returns a map of
// meter-prop overrides. WidgetHost spreads these over the meter's props (AGENTS.md §6: the container
// owns the wiring; meters stay presentational). The WASM engine is loaded lazily — only when a widget
// actually has a non-empty formula — so a layout of plain gauges/clocks never pays for it.
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import type { TelemetryHub } from '../core/telemetry';
import type { ExprField } from '../core/widget';
import { exprRefs, parseTemplate, renderTemplate, templateRefs } from '../core/textTemplate';
import { useSensors } from '../widgets/useSensors';
import {
	evalExpr,
	initFormulaEngine,
	isFormulaEngineReady,
	onFormulaEngineReady,
	retainFormulas
} from './engine';

/** Re-renders when the (async) WASM engine finishes initializing. Does NOT itself trigger init. */
export function useEngineReady(): boolean {
	return useSyncExternalStore(onFormulaEngineReady, isFormulaEngineReady, isFormulaEngineReady);
}

export type FormulaState = { ready: boolean; overrides: Record<string, number | string> };

export function useFormulaFields(
	hub: TelemetryHub,
	fields: ExprField[],
	config: Record<string, unknown>
): FormulaState {
	// Expr fields with a non-empty formula in config. (`config` is stable from layout state, so these
	// memos only recompute when the user actually edits a formula — honest exhaustive-deps.)
	const active = useMemo(
		() =>
			fields.filter(
				(f) => typeof config[f.key] === 'string' && (config[f.key] as string).trim() !== ''
			),
		[fields, config]
	);

	const refs = useMemo(() => {
		const all: string[] = [];
		for (const f of active) {
			const src = config[f.key] as string;
			all.push(...(f.result === 'text' ? templateRefs(src) : exprRefs(src)));
		}
		return Array.from(new Set(all));
	}, [active, config]);

	const values = useSensors(hub, refs);
	const ready = useEngineReady();

	// Load the WASM engine only once a formula is actually present.
	useEffect(() => {
		if (active.length > 0) void initFormulaEngine();
	}, [active.length]);

	// The exact expression sources this widget evaluates, keyed by content so an unchanged formula
	// keeps its context across config identity changes; released (and disposed) on change/unmount.
	const sourcesKey = useMemo(() => {
		const sources: string[] = [];
		for (const f of active) {
			const src = config[f.key] as string;
			if (f.result !== 'text') sources.push(src);
			else for (const part of parseTemplate(src)) if (part.kind === 'expr') sources.push(part.src);
		}
		return JSON.stringify(sources);
	}, [active, config]);
	useEffect(() => retainFormulas(JSON.parse(sourcesKey) as string[]), [sourcesKey]);

	const overrides = useMemo(() => {
		const out: Record<string, number | string> = {};
		if (!ready) return out;
		for (const f of active) {
			const src = config[f.key] as string;
			const v =
				f.result === 'text'
					? renderTemplate(parseTemplate(src), (e) => evalExpr(e, values))
					: evalExpr(src, values);
			if (v !== null && v !== '') out[f.target] = v;
		}
		return out;
	}, [ready, active, config, values]);

	return { ready, overrides };
}
