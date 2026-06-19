import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import Rss from './Rss';
import { TelemetryHubContext } from '../telemetryContext';
import { createTelemetryHub, type TelemetryHub } from '../../core/telemetry';

afterEach(cleanup);

const withHub = (hub: TelemetryHub | null, node: React.ReactNode) =>
	render(<TelemetryHubContext.Provider value={hub}>{node}</TelemetryHubContext.Provider>);

const feed = (hub: TelemetryHub, value: unknown): void =>
	act(() => hub.ingest({ sensor: 'rss.list', ts_ms: Date.now(), value: { kind: 'json', value } }));

describe('Rss', () => {
	it('shows the empty state before any headlines arrive', () => {
		const { container } = withHub(createTelemetryHub(), <Rss title="News" />);
		expect(container.querySelector('[data-part="empty"]')?.textContent).toBe('No headlines yet');
		// The title still renders above the empty placeholder.
		expect(container.querySelector('.rss-title')?.textContent).toBe('News');
	});

	it('renders no header when no title is given', () => {
		const { container } = withHub(createTelemetryHub(), <Rss />);
		expect(container.querySelector('.rss-head')).toBeNull();
	});

	it('renders headline titles from the rss.list json sensor', () => {
		const hub = createTelemetryHub();
		const { container } = withHub(hub, <Rss />);
		feed(hub, [
			{ title: 'First', link: 'https://a' },
			{ title: 'Second', link: '' }
		]);
		const rows = container.querySelectorAll('.rss-item');
		expect(Array.from(rows).map((r) => r.textContent)).toEqual(['First', 'Second']);
		// link falls back to the title in the tooltip when absent.
		expect(rows[0].getAttribute('title')).toBe('https://a');
		expect(rows[1].getAttribute('title')).toBe('Second');
	});

	it('caps the list at maxRows', () => {
		const hub = createTelemetryHub();
		const { container } = withHub(hub, <Rss maxRows={2} />);
		feed(hub, [{ title: 'a' }, { title: 'b' }, { title: 'c' }]);
		expect(container.querySelectorAll('.rss-row')).toHaveLength(2);
	});

	it('only re-renders on an actual change (same payload keeps the same rows)', () => {
		const hub = createTelemetryHub();
		const { container } = withHub(hub, <Rss />);
		feed(hub, [{ title: 'x' }]);
		const firstLi = container.querySelector('.rss-row');
		feed(hub, [{ title: 'x' }]); // identical signature → no state change
		expect(container.querySelector('.rss-row')).toBe(firstLi);
	});

	it('passes a per-instance color as the --rss-accent CSS variable', () => {
		const { container } = withHub(createTelemetryHub(), <Rss color="rgb(9, 8, 7)" />);
		const root = container.querySelector('.np-rss') as HTMLElement;
		expect(root.style.getPropertyValue('--rss-accent')).toBe('rgb(9, 8, 7)');
	});

	it('sets no inline style when no color is given', () => {
		const { container } = withHub(createTelemetryHub(), <Rss />);
		expect((container.querySelector('.np-rss') as HTMLElement).getAttribute('style')).toBeNull();
	});

	it('renders nothing from the hub when there is no provider (hub is null)', () => {
		const { container } = withHub(null, <Rss />);
		// The effect early-returns; the empty placeholder is shown.
		expect(container.querySelector('[data-part="empty"]')).toBeTruthy();
	});
});
