import { describe, it, expect } from 'vitest';
import { emptyRoot, isContainer, isLeaf, isGroup, type MonitorLayout } from './layoutTree';
import {
	applyAssistantOps,
	applyDelta,
	buildAssistantMessages,
	buildBriefingMessages,
	buildLayoutUserPrompt,
	buildTranslateMessages,
	buildLayoutSystemPrompt,
	describeLayout,
	emptyChat,
	formatReadings,
	parseAssistantReply,
	providerMeta,
	pushUser,
	startTurn,
	toMessages,
	type AssistantOp
} from './llm';
import { container, group, leaf } from './layoutTree';
import { createWidget, registerMeta } from './widget';
import { listMetas, type WidgetMeta } from './widget';

const monitor = (): MonitorLayout => ({ root: emptyRoot(), floating: [] });

// A deterministic id generator for the pure applier (the editor passes a rand-based one).
function counter(): (type: string) => string {
	let n = 0;
	return (type: string) => `${type}-${++n}`;
}

describe('providers', () => {
	it('resolves known providers and falls back to openai', () => {
		expect(providerMeta('ollama').needsKey).toBe(false);
		expect(providerMeta('anthropic').needsKey).toBe(true);
		expect(providerMeta('nonsense').id).toBe('openai');
	});
});

describe('chat reducer (applyDelta)', () => {
	it('streams tokens into the matching turn and finalizes on done', () => {
		let s = startTurn(emptyChat(), 'r1');
		s = applyDelta(s, { requestId: 'r1', token: 'Hel', done: false });
		s = applyDelta(s, { requestId: 'r1', token: 'lo', done: false });
		expect(s.turns[0].content).toBe('Hello');
		expect(s.turns[0].streaming).toBe(true);
		s = applyDelta(s, { requestId: 'r1', token: '', done: true });
		expect(s.turns[0].streaming).toBe(false);
	});

	it('records an error frame and stops streaming', () => {
		let s = startTurn(emptyChat(), 'r1');
		s = applyDelta(s, { requestId: 'r1', token: '', done: true, error: 'bad key' });
		expect(s.turns[0].error).toBe('bad key');
		expect(s.turns[0].streaming).toBe(false);
	});

	it('seeds a turn for an unknown id rather than dropping the token', () => {
		const s = applyDelta(emptyChat(), { requestId: 'x', token: 'hi', done: false });
		expect(s.turns).toHaveLength(1);
		expect(s.turns[0].content).toBe('hi');
	});

	it('returns the SAME state for a no-op frame (duplicate done / done for unknown id)', () => {
		const base = applyDelta(startTurn(emptyChat(), 'r1'), {
			requestId: 'r1',
			token: 'hi',
			done: true
		});
		// a second terminal done for the now-finalized turn changes nothing → same reference (no re-render)
		expect(applyDelta(base, { requestId: 'r1', token: '', done: true })).toBe(base);
		// a done for an id we never opened is also a no-op
		expect(applyDelta(base, { requestId: 'ghost', token: '', done: true })).toBe(base);
	});

	it('seeds an unknown-id turn already in the error state when the first frame is an error', () => {
		// not done, unknown id, but carries an error → seed a non-streaming turn that records it.
		const s = applyDelta(emptyChat(), {
			requestId: 'z',
			token: '',
			done: false,
			error: 'rate limited'
		});
		expect(s.turns).toHaveLength(1);
		expect(s.turns[0].error).toBe('rate limited');
		expect(s.turns[0].streaming).toBe(false);
	});
});

describe('pushUser / toMessages', () => {
	it('appends a user turn', () => {
		const s = pushUser(emptyChat(), 'u1', 'hello there');
		expect(s.turns).toEqual([{ id: 'u1', role: 'user', content: 'hello there' }]);
	});

	it('flattens the transcript to ChatMessages, dropping empty + errored turns', () => {
		let s = pushUser(emptyChat(), 'u1', 'hi');
		s = startTurn(s, 'a1'); // empty streaming assistant turn → dropped (content.length 0)
		s = applyDelta(s, { requestId: 'a1', token: 'hey', done: true });
		s = startTurn(s, 'a2'); // a second turn we mark errored → dropped
		s = applyDelta(s, { requestId: 'a2', token: 'partial', done: true, error: 'boom' });
		expect(toMessages(s)).toEqual([
			{ role: 'user', content: 'hi' },
			{ role: 'assistant', content: 'hey' }
		]);
	});
});

describe('parseAssistantReply', () => {
	it('parses a bare ops object', () => {
		const r = parseAssistantReply('{"ops":[{"op":"clear"}],"summary":"cleared"}');
		expect(r?.ops).toEqual([{ op: 'clear' }]);
		expect(r?.summary).toBe('cleared');
	});

	it('tolerates markdown fences and surrounding prose', () => {
		const reply =
			'Sure!\n```json\n{ "ops": [ { "op": "addWidget", "widgetType": "gauge" } ], "summary": "added a gauge" }\n```\nDone.';
		const r = parseAssistantReply(reply);
		expect(r?.ops).toHaveLength(1);
		expect((r!.ops[0] as { widgetType: string }).widgetType).toBe('gauge');
	});

	it('drops ops with an unknown verb and returns the valid ones', () => {
		const r = parseAssistantReply('{"ops":[{"op":"nuke"},{"op":"clear"}]}');
		expect(r?.ops).toEqual([{ op: 'clear' }]);
	});

	it('skips a leading sibling object (reasoning envelope) and finds the ops object', () => {
		const reply =
			'{"thinking":"let me plan {nested}"}\n{"ops":[{"op":"clear"}],"summary":"cleared"}';
		const r = parseAssistantReply(reply);
		expect(r?.ops).toEqual([{ op: 'clear' }]);
		expect(r?.summary).toBe('cleared');
	});

	it('returns null on non-JSON / missing ops', () => {
		expect(parseAssistantReply('no json here')).toBeNull();
		expect(parseAssistantReply('{"summary":"x"}')).toBeNull();
	});

	it('skips a candidate that parses to a non-object (a bare JSON value)', () => {
		// `{ "x": 5 }` has no ops, then the whole string parses but is not the ops shape; a leading
		// candidate that JSON.parses to null/number is skipped via the typeof guard.
		const r = parseAssistantReply('{"v": null}\n{"ops":[{"op":"clear"}]}');
		expect(r?.ops).toEqual([{ op: 'clear' }]);
	});

	it('ignores braces inside string literals (escapes do not miscount depth)', () => {
		// The summary string contains an escaped quote and a brace; the brace-counter must not be
		// fooled into ending the object early.
		const r = parseAssistantReply('{"ops":[{"op":"clear"}],"summary":"a \\" and a } brace"}');
		expect(r?.ops).toEqual([{ op: 'clear' }]);
		expect(r?.summary).toBe('a " and a } brace');
	});

	it('returns null when the only brace opens an unbalanced (never-closed) object', () => {
		// No balanced candidate yields, and the whole-string fallback fails to parse → null.
		expect(parseAssistantReply('prefix {"ops":[{"op":"clear"}')).toBeNull();
	});

	it('skips a whole-string candidate that JSON-parses to a falsy value (null)', () => {
		// No `{` → jsonObjectCandidates yields nothing; the whole-string fallback parses to `null`,
		// which the `!parsed` guard rejects → null.
		expect(parseAssistantReply('null')).toBeNull();
	});
});

describe('briefing', () => {
	it('formats a readings snapshot and drops blanks', () => {
		expect(formatReadings({ 'cpu.total': 42, 'gpu.util': 7, 'net.adapter': '' })).toBe(
			'cpu.total=42, gpu.util=7'
		);
		expect(formatReadings({})).toBe('(no readings available)');
	});

	it('builds a system + user briefing message pair', () => {
		const m = buildBriefingMessages({ 'cpu.total': 90 });
		expect(m).toHaveLength(2);
		expect(m[0].role).toBe('system');
		expect(m[1].content).toContain('cpu.total=90');
	});

	it('builds an assistant message pair from a custom prompt + readings', () => {
		const m = buildAssistantMessages('Are we OK?', { 'cpu.total': 50 });
		expect(m[0].role).toBe('system');
		expect(m[1].content).toContain('Are we OK?');
		expect(m[1].content).toContain('cpu.total=50');
	});

	it('falls back to a default instruction when the assistant prompt is blank', () => {
		const m = buildAssistantMessages('   ', { 'cpu.total': 50 });
		expect(m[1].content).toContain('Summarize my system status in one short sentence.');
	});

	it('builds translate messages targeting a language', () => {
		const m = buildTranslateMessages('hello', 'Spanish');
		expect(m[0].content).toContain('Spanish');
		expect(m[1].content).toBe('hello');
		// blank target falls back to English
		expect(buildTranslateMessages('hi', '  ')[0].content).toContain('English');
	});
});

describe('buildLayoutSystemPrompt', () => {
	it('lists real widget types and the supplied sensors', () => {
		const prompt = buildLayoutSystemPrompt(listMetas(), ['cpu.total', 'gpu.util']);
		expect(prompt).toContain('gauge');
		expect(prompt).toContain('cpu.total');
		expect(prompt).toContain('gpu.util');
		// the op grammar is taught
		expect(prompt).toContain('addWidget');
	});

	it('filters out the spacer and exercises the meta-default fallbacks', () => {
		// A bare meta with no defaultConfig/binds/description/label exercises every `??` fallback:
		// binds defaults to 'scalar' ("takes a sensor"), no config string, falls back to the type as label.
		const metas: WidgetMeta[] = [
			{ type: 'spacer' }, // filtered out
			{ type: 'bare' }, // no binds → 'scalar' → "takes a sensor"; no cfg; label/desc → type
			{ type: 'selfsrc', binds: 'none', label: 'Self', description: 'a self-sourcing widget' }
		];
		const prompt = buildLayoutSystemPrompt(metas, []);
		expect(prompt).not.toContain('- spacer:');
		expect(prompt).toContain('- bare: bare takes a sensor.');
		expect(prompt).toContain('- selfsrc: a self-sourcing widget self-sourcing (no sensor).');
		// empty sensor list renders the placeholder
		expect(prompt).toContain('(none reported yet)');
	});

	it('uses the label when there is no description', () => {
		const prompt = buildLayoutSystemPrompt(
			[{ type: 'x', label: 'Labelled', defaultConfig: { color: 'red' } }],
			['cpu.total']
		);
		// label is used as the description fallback, and config keys are listed
		expect(prompt).toContain('- x: Labelled takes a sensor. config: color.');
	});
});

describe('buildLayoutUserPrompt', () => {
	it('renders an empty layout placeholder and the instruction', () => {
		const p = buildLayoutUserPrompt('add a clock', monitor());
		expect(p).toContain('Current layout:\n(empty)');
		expect(p).toContain('Request: add a clock');
	});

	it('lists each placed widget with its container and sensor', () => {
		const res = applyAssistantOps(
			monitor(),
			[{ op: 'addWidget', widgetType: 'gauge', sensor: 'cpu.total' }],
			counter()
		);
		const id = res.addedIds[0];
		const p = buildLayoutUserPrompt('tweak it', res.monitor);
		expect(p).toContain(`${id} (gauge, sensor=cpu.total) in`);
	});

	it('omits the sensor= clause for a self-sourcing (sensorless) widget', () => {
		const res = applyAssistantOps(monitor(), [{ op: 'addWidget', widgetType: 'clock' }], counter());
		const id = res.addedIds[0];
		const p = buildLayoutUserPrompt('go', res.monitor);
		// clock self-sources → no `sensor=` clause for that line
		expect(p).toContain(`${id} (clock) in`);
		expect(p).not.toContain(`${id} (clock, sensor=`);
	});
});

describe('describeLayout', () => {
	it('describes a group leaf as type "group" and walks floating nodes', () => {
		const clock = leaf(createWidget('clock', 'c1'));
		const g = leaf(group('g1', { w: 100, h: 100 }, clock));
		const floatingGauge = leaf(createWidget('gauge', 'f1'));
		const m: MonitorLayout = {
			root: container('root', 'col', [g]),
			floating: [floatingGauge]
		};
		const items = describeLayout(m);
		const grp = items.find((i) => i.id === 'g1');
		expect(grp?.type).toBe('group');
		expect(grp?.container).toBe('root');
		const flt = items.find((i) => i.id === 'f1');
		expect(flt?.container).toBe('floating');
	});
});

describe('applyAssistantOps', () => {
	it('adds a sensor-bound widget into the root', () => {
		const ops: AssistantOp[] = [
			{ op: 'addWidget', widgetType: 'gauge', sensor: 'cpu.total', config: { label: 'CPU' } }
		];
		const res = applyAssistantOps(monitor(), ops, counter());
		expect(res.applied).toBe(1);
		expect(res.errors).toHaveLength(0);
		const items = describeLayout(res.monitor);
		expect(items).toHaveLength(1);
		expect(items[0].type).toBe('gauge');
		expect(items[0].sensor).toBe('cpu.total');
		// the config override landed
		const leafNode = res.monitor.root.children[0];
		expect(isLeaf(leafNode) && !isGroup(leafNode.unit) && leafNode.unit.config.label).toBe('CPU');
	});

	it('rejects a sensor on a self-sourcing widget but still places it', () => {
		const res = applyAssistantOps(
			monitor(),
			[{ op: 'addWidget', widgetType: 'clock', sensor: 'cpu.total' }],
			counter()
		);
		expect(res.applied).toBe(1);
		expect(res.errors.join(' ')).toMatch(/self-sourcing/);
		expect(describeLayout(res.monitor)[0].sensor).toBeUndefined();
	});

	it('setSensor enforces the self-sourcing gate too (a clock cannot be given a sensor)', () => {
		let res = applyAssistantOps(monitor(), [{ op: 'addWidget', widgetType: 'clock' }], counter());
		const id = res.addedIds[0];
		res = applyAssistantOps(res.monitor, [{ op: 'setSensor', id, sensor: 'cpu.total' }], counter());
		expect(res.applied).toBe(0);
		expect(res.errors.join(' ')).toMatch(/self-sourcing/);
		expect(describeLayout(res.monitor)[0].sensor).toBeUndefined();
	});

	it('setSensor rebinds a sensor-bound widget', () => {
		let res = applyAssistantOps(
			monitor(),
			[{ op: 'addWidget', widgetType: 'gauge', sensor: 'cpu.total' }],
			counter()
		);
		const id = res.addedIds[0];
		res = applyAssistantOps(res.monitor, [{ op: 'setSensor', id, sensor: 'gpu.util' }], counter());
		expect(res.applied).toBe(1);
		expect(describeLayout(res.monitor)[0].sensor).toBe('gpu.util');
	});

	it('a sensor-bound widget added with no sensor keeps its type default (intentional)', () => {
		// addWidget gauge with no `sensor` inherits the meta default (cpu.total) — a useful starting
		// point the user can rebind, rather than an unbound placeholder. Pinned so it can't drift silently.
		const res = applyAssistantOps(monitor(), [{ op: 'addWidget', widgetType: 'gauge' }], counter());
		expect(describeLayout(res.monitor)[0].sensor).toBe('cpu.total');
	});

	it("defaults a meta with no explicit binds to 'scalar' (sensor is accepted)", () => {
		// Every built-in meta declares binds; register a synthetic one with binds undefined to drive
		// the `meta.binds ?? 'scalar'` fallback in addWidget — the sensor must then be accepted.
		registerMeta({ type: 'no-binds-test', label: 'NoBinds' });
		let res = applyAssistantOps(
			monitor(),
			[{ op: 'addWidget', widgetType: 'no-binds-test', sensor: 'cpu.total' }],
			counter()
		);
		expect(res.applied).toBe(1);
		expect(res.errors).toHaveLength(0);
		expect(describeLayout(res.monitor)[0].sensor).toBe('cpu.total');

		// setSensor on the same leaf drives leafBinds' `?? 'scalar'` fallback (meta.binds undefined),
		// which the SENSOR_BINDS gate then accepts.
		const id = res.addedIds[0];
		res = applyAssistantOps(res.monitor, [{ op: 'setSensor', id, sensor: 'gpu.util' }], counter());
		expect(res.applied).toBe(1);
		expect(describeLayout(res.monitor)[0].sensor).toBe('gpu.util');
	});

	it('reports an unknown widget type without aborting the batch', () => {
		const res = applyAssistantOps(
			monitor(),
			[
				{ op: 'addWidget', widgetType: 'definitely-not-real' },
				{ op: 'addWidget', widgetType: 'clock' }
			],
			counter()
		);
		expect(res.applied).toBe(1); // only the clock
		expect(res.errors.join(' ')).toMatch(/unknown widget type/);
		expect(describeLayout(res.monitor)).toHaveLength(1);
	});

	it('removes, reconfigures, and clears', () => {
		let res = applyAssistantOps(
			monitor(),
			[{ op: 'addWidget', widgetType: 'gauge', sensor: 'cpu.total' }],
			counter()
		);
		const id = res.addedIds[0];
		res = applyAssistantOps(
			res.monitor,
			[{ op: 'setConfig', id, config: { max: 200 } }],
			counter()
		);
		const node = res.monitor.root.children[0];
		expect(isLeaf(node) && !isGroup(node.unit) && node.unit.config.max).toBe(200);

		res = applyAssistantOps(res.monitor, [{ op: 'removeWidget', id }], counter());
		expect(describeLayout(res.monitor)).toHaveLength(0);

		// clear is a no-op-safe reset
		const cleared = applyAssistantOps(res.monitor, [{ op: 'clear' }], counter());
		expect(isContainer(cleared.monitor.root)).toBe(true);
		expect(cleared.monitor.root.children).toHaveLength(0);
	});

	it('nests into a created container', () => {
		let res = applyAssistantOps(monitor(), [{ op: 'addContainer', kind: 'row' }], counter());
		const containerId = res.addedIds[0];
		res = applyAssistantOps(
			res.monitor,
			[{ op: 'addWidget', widgetType: 'clock', parent: containerId }],
			counter()
		);
		const item = describeLayout(res.monitor).find((i) => i.type === 'clock');
		expect(item?.container).toBe(containerId);
	});

	it('does not mutate the input monitor', () => {
		const m = monitor();
		const before = JSON.stringify(m);
		applyAssistantOps(m, [{ op: 'addWidget', widgetType: 'clock' }], counter());
		expect(JSON.stringify(m)).toBe(before);
	});

	it('falls back to the root for an unknown parent container (with an error note)', () => {
		const res = applyAssistantOps(
			monitor(),
			[{ op: 'addWidget', widgetType: 'clock', parent: 'no-such-container' }],
			counter()
		);
		expect(res.applied).toBe(1);
		expect(res.errors.join(' ')).toMatch(/unknown container "no-such-container"/);
		// landed on root anyway
		expect(describeLayout(res.monitor)[0].container).toBe(res.monitor.root.id);
	});

	it('rejects a parent id that resolves to a widget leaf (not a container) → root', () => {
		let res = applyAssistantOps(monitor(), [{ op: 'addWidget', widgetType: 'clock' }], counter());
		const leafId = res.addedIds[0];
		res = applyAssistantOps(
			res.monitor,
			[{ op: 'addWidget', widgetType: 'gauge', parent: leafId }],
			counter()
		);
		expect(res.errors.join(' ')).toMatch(/unknown container/);
		expect(describeLayout(res.monitor).find((i) => i.type === 'gauge')?.container).toBe(
			res.monitor.root.id
		);
	});

	it('creates a grid container with its grid defaults', () => {
		const res = applyAssistantOps(monitor(), [{ op: 'addContainer', kind: 'grid' }], counter());
		expect(res.applied).toBe(1);
		const node = res.monitor.root.children[0];
		expect(isContainer(node) && node.kind).toBe('grid');
		expect(isContainer(node) && node.cols).toBe(2);
		expect(isContainer(node) && node.rows).toBe(2);
	});

	it('reports removeWidget on a missing id without aborting', () => {
		const res = applyAssistantOps(monitor(), [{ op: 'removeWidget', id: 'ghost' }], counter());
		expect(res.applied).toBe(0);
		expect(res.errors.join(' ')).toMatch(/cannot remove "ghost" — not found/);
	});

	it('reports setConfig on a non-widget (a container) without aborting', () => {
		let res = applyAssistantOps(monitor(), [{ op: 'addContainer', kind: 'row' }], counter());
		const containerId = res.addedIds[0];
		res = applyAssistantOps(
			res.monitor,
			[{ op: 'setConfig', id: containerId, config: { x: 1 } }],
			counter()
		);
		expect(res.applied).toBe(0);
		expect(res.errors.join(' ')).toMatch(/cannot configure ".*" — not a widget/);
	});

	it('reports setSensor on a non-widget (a container) — leafBinds returns null', () => {
		let res = applyAssistantOps(monitor(), [{ op: 'addContainer', kind: 'row' }], counter());
		const containerId = res.addedIds[0];
		res = applyAssistantOps(
			res.monitor,
			[{ op: 'setSensor', id: containerId, sensor: 'cpu.total' }],
			counter()
		);
		expect(res.applied).toBe(0);
		expect(res.errors.join(' ')).toMatch(/cannot set sensor on ".*" — not a widget/);
	});
});
