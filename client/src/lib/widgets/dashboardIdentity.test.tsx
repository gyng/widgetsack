import { cleanup, fireEvent, render, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WidgetHost from './WidgetHost';
import WidgetPreview from './WidgetPreview';
import { createWidget } from '../core/widget';
import { createTelemetryHub } from '../core/telemetry';
beforeEach(() => localStorage.clear());
afterEach(cleanup);
describe('dashboard instance identity and previews', () => {
	it('keeps checklists independent across two copies of the same library definition', () => {
		const hub = createTelemetryHub();
		const instance = createWidget('checklist', 'shared-definition-child');
		const view = render(
			<>
				<WidgetHost hub={hub} instance={instance} domId="copy-one/shared-definition-child" />
				<WidgetHost hub={hub} instance={instance} domId="copy-two/shared-definition-child" />
			</>
		);
		const first = within(view.getAllByRole('region', { name: 'Today' })[0]);
		fireEvent.change(first.getByRole('textbox'), { target: { value: 'Only in the first copy' } });
		fireEvent.submit(first.getByRole('textbox').closest('form')!);
		view.unmount();
		const second = render(
			<WidgetHost hub={hub} instance={instance} domId="copy-two/shared-definition-child" />
		);
		expect(second.queryByText('Only in the first copy')).toBeNull();
	});
	it('shows an all-clear preview and keeps its task controls read-only', () => {
		const alerts = render(<WidgetPreview type="alerts" />);
		expect(alerts.getByText('All clear')).toBeVisible();
		alerts.unmount();
		const checklist = render(<WidgetPreview type="checklist" />);
		expect(checklist.getByRole('textbox')).toBeDisabled();
	});
});
