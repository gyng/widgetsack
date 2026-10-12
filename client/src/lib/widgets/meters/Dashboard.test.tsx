import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Alerts from './Alerts';
import Checklist from './Checklist';
import History from './History';
import ServiceHealth from './ServiceHealth';
import AudioMixer from './AudioMixer';
afterEach(cleanup);
describe('dashboard meters', () => {
	it('shows only active alerts and exposes snooze while keeping editing passive', () => {
		const onSnooze = vi.fn();
		const props = { alerts: [], label: 'Attention', snoozeMin: 15, editMode: false, onSnooze };
		const { container, rerender } = render(<Alerts {...props} />);
		expect(container.querySelector('[data-widget-interactive="none"]')).not.toBeVisible();
		rerender(<Alerts {...props} editMode />);
		expect(screen.getByText('All clear')).toBeVisible();
		rerender(
			<Alerts
				{...props}
				alerts={[{ id: 'x', sensor: 'cpu', op: 'above', threshold: 90, label: 'Busy' }]}
			/>
		);
		fireEvent.click(screen.getByRole('button', { name: 'Snooze Busy' }));
		expect(onSnooze).toHaveBeenCalledWith('x');
	});
	it('renders checkbox, add, remove, and persistence feedback contracts', () => {
		const onAdd = vi.fn(),
			onDraft = vi.fn(),
			onToggle = vi.fn(),
			onRemove = vi.fn();
		const props = {
			tasks: [
				{ id: '1', text: 'Read', done: false },
				{ id: '2', text: 'Write', done: true }
			],
			draft: '',
			label: 'Today',
			editMode: false,
			error: '',
			onAdd,
			onDraft,
			onToggle,
			onRemove
		};
		const { rerender } = render(<Checklist {...props} />);
		expect(screen.getByText('Today · 1/2')).toBeVisible();
		fireEvent.click(screen.getByRole('checkbox', { name: 'Read' }));
		expect(onToggle).toHaveBeenCalledWith('1');
		fireEvent.click(screen.getByRole('button', { name: 'Remove Read' }));
		expect(onRemove).toHaveBeenCalledWith('1');
		fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Learn' } });
		expect(onDraft).toHaveBeenCalledWith('Learn');
		fireEvent.submit(screen.getByRole('textbox').closest('form')!);
		expect(onAdd).toHaveBeenCalledOnce();
		rerender(<Checklist {...props} draft="Learn" editMode error="Not saved" />);
		expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled();
		expect(screen.getByRole('alert')).toHaveTextContent('Not saved');
	});
	it('compares multiple histories with summaries and a threshold band', () => {
		const { rerender } = render(<History />);
		expect(screen.getByText('History · 0.0–1.0')).toBeVisible();
		const sensors = {
			CPU: { value: null, history: [0, 50, 100] },
			GPU: { value: null, history: [10, 20] },
			Empty: { value: null, history: [] }
		};
		rerender(<History sensors={sensors} fixedScale showThreshold threshold={80} smooth />);
		expect(screen.getByText(/CPU · min 0.0 \/ avg 50.0 \/ max 100.0/)).toBeVisible();
		expect(screen.getByTitle('Threshold 80')).toHaveStyle({ height: '20%' });
		rerender(<History sensors={sensors} seconds={2} showStats={false} />);
		expect(screen.getByText('CPU')).toBeVisible();
	});
	it('reports status, latency, certificate warnings, failures, and unconfigured health endpoints', () => {
		const props = { result: null, label: 'NAS', url: '', slowMs: 1000, warnDays: 14, busy: false };
		const { rerender } = render(<ServiceHealth {...props} />);
		expect(screen.getByText(/Set an HTTP/)).toBeVisible();
		rerender(<ServiceHealth {...props} url="https://nas" />);
		expect(screen.getByText('Checking…')).toBeVisible();
		const result = { status: 200, latencyMs: 30, certificateDays: 10, error: null };
		rerender(
			<ServiceHealth
				{...props}
				url="https://nas"
				result={{ ...result, status: 302, certificateDays: 60 }}
			/>
		);
		expect(screen.getByLabelText('NAS')).toHaveAttribute('data-state', 'warning');
		expect(screen.getByText(/redirect · 302/)).toBeVisible();
		rerender(<ServiceHealth {...props} url="https://nas" result={result} busy />);
		expect(screen.getByLabelText('NAS')).toHaveAttribute('data-state', 'warning');
		expect(screen.getByText('Certificate expires in 10 days')).toBeVisible();
		rerender(<ServiceHealth {...props} result={{ ...result, certificateDays: null }} />);
		expect(screen.getByLabelText('NAS')).toHaveAttribute('data-state', 'up');
		rerender(
			<ServiceHealth {...props} result={{ ...result, latencyMs: 1000, certificateDays: 60 }} />
		);
		expect(screen.getByLabelText('NAS')).toHaveAttribute('data-state', 'slow');
		rerender(<ServiceHealth {...props} result={{ ...result, status: 500 }} />);
		expect(screen.getByLabelText('NAS')).toHaveAttribute('data-state', 'down');
		rerender(<ServiceHealth {...props} url="https://nas" result={{ ...result, status: null }} />);
		expect(screen.getByText(/no response/)).toBeVisible();
		rerender(<ServiceHealth {...props} result={{ ...result, error: 'TLS invalid' }} />);
		expect(screen.getByRole('alert')).toHaveTextContent('TLS invalid');
	});
	it('targets app sessions and explicitly displays microphone mute state', () => {
		const onLevel = vi.fn(),
			onMute = vi.fn(),
			onMicrophone = vi.fn();
		const props = {
			snapshot: null,
			error: '',
			busy: false,
			showMicrophone: true,
			editMode: false,
			onLevel,
			onMute,
			onMicrophone
		};
		const { rerender } = render(<AudioMixer {...props} />);
		expect(screen.getByText('Loading…')).toBeVisible();
		const snapshot = {
			sessions: [{ id: 's1', name: 'Player', level: 0.5, muted: false }],
			microphone: { level: 1, muted: false }
		};
		rerender(<AudioMixer {...props} snapshot={snapshot} />);
		fireEvent.change(screen.getByRole('slider'), { target: { value: '80' } });
		expect(onLevel).toHaveBeenCalledWith('s1', 0.8);
		fireEvent.click(screen.getByRole('button', { name: 'Player mute' }));
		expect(onMute).toHaveBeenCalledWith('s1', true);
		fireEvent.click(screen.getByRole('button', { name: 'Mute mic' }));
		expect(onMicrophone).toHaveBeenCalledWith(true);
		rerender(
			<AudioMixer
				{...props}
				snapshot={{
					sessions: [{ ...snapshot.sessions[0], muted: true }],
					microphone: { level: 1, muted: true }
				}}
			/>
		);
		fireEvent.click(screen.getByRole('button', { name: 'Player unmute' }));
		expect(onMute).toHaveBeenCalledWith('s1', false);
		fireEvent.click(screen.getByRole('button', { name: 'Unmute mic' }));
		expect(onMicrophone).toHaveBeenCalledWith(false);
		rerender(
			<AudioMixer {...props} snapshot={{ sessions: [], microphone: null }} error="Offline" />
		);
		expect(screen.getByText('No app audio sessions')).toBeVisible();
		expect(screen.getByRole('alert')).toHaveTextContent('Offline');
		rerender(
			<AudioMixer
				{...props}
				snapshot={{
					sessions: [],
					microphone: snapshot.microphone,
					sessionError: 'Output unavailable'
				}}
			/>
		);
		expect(screen.getByRole('alert')).toHaveTextContent('Output unavailable');
		expect(screen.getByRole('button', { name: 'Mute mic' })).toBeEnabled();
		rerender(<AudioMixer {...props} snapshot={snapshot} showMicrophone={false} busy editMode />);
		expect(screen.getByRole('slider')).toBeDisabled();
	});
});
