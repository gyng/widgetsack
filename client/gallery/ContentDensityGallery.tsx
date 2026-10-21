import { useMemo, type CSSProperties } from 'react';
import { DESIGN_DENSITIES, designPresetTokens } from '../src/lib/core/designPresets';
import { createWidget } from '../src/lib/core/widget';
import WidgetHost from '../src/lib/widgets/WidgetHost';
import { TelemetryHubContext } from '../src/lib/widgets/telemetryContext';
import Assistant from '../src/lib/widgets/meters/Assistant';
import { TranscribeView } from '../src/lib/widgets/meters/Transcribe';
import { TimerView } from '../src/lib/widgets/meters/Timer';
import { makeHub } from './seed';

const types = [
	'calendar',
	'gpu',
	'disks',
	'topproc',
	'procwatch',
	'netconn',
	'ping',
	'wifi',
	'recyclebin',
	'note',
	'countdown',
	'timer',
	'weather',
	'sunmoon',
	'airquality',
	'rss',
	'agenda'
];
const control = () => {};

/** Full host wiring with seeded readings; AI/microphone views stay local and never acquire devices. */
export default function ContentDensityGallery() {
	const hub = useMemo(() => makeHub(), []);
	const widgets = useMemo(
		() =>
			types.map((type) => {
				const widget = createWidget(type, `density-${type}`);
				if (type === 'countdown')
					widget.config = { ...widget.config, mode: 'pomodoro', label: 'Focus' };
				if (type === 'note')
					widget.config = { ...widget.config, placeholder: 'Review the layout\nWater the plants' };
				if (type === 'timer') {
					widget.config = { ...widget.config, style: 'dial' };
					widget.rect.h = 260;
				}
				if (type === 'rss') widget.config = { ...widget.config, title: 'Headlines' };
				if (type === 'agenda') widget.config = { ...widget.config, title: 'Agenda' };
				return widget;
			}),
		[]
	);
	return (
		<TelemetryHubContext.Provider value={hub}>
			<h1>Content widget density comparison</h1>
			<p>
				Seeded readings in authored boxes. The optional timer dial has extra height. Larger
				densities use larger boxes; saved boxes keep their dimensions.
			</p>
			{DESIGN_DENSITIES.map((density, index) => (
				<section
					key={density.id}
					data-density={density.id}
					style={designPresetTokens('transparent', density.id) as CSSProperties}
				>
					<h2>{density.name}</h2>
					<div
						className="grid"
						style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 540px), 1fr))' }}
					>
						{widgets.map((widget) => (
							<figure className="cell" key={widget.id}>
								<div
									className="content-density-meter"
									data-meter={widget.type}
									style={{
										position: 'relative',
										width: Math.ceil(widget.rect.w * [1, 1.3, 1.9][index]),
										height: Math.ceil(widget.rect.h * [1, 1.3, 1.9][index])
									}}
								>
									<WidgetHost hub={hub} instance={widget} flow />
								</div>
								<figcaption>{widget.type}</figcaption>
							</figure>
						))}
						{['prompt', 'transcribe', 'timer-digital'].map((type) => (
							<figure className="cell" key={type}>
								<div
									className="content-density-meter"
									data-meter={type}
									style={{
										width: Math.ceil(260 * [1, 1.3, 1.9][index]),
										height: Math.ceil(120 * [1, 1.3, 1.9][index]),
										fontSize: 'var(--np-text-body)',
										lineHeight: 'var(--np-line-body)'
									}}
								>
									{type === 'prompt' ? (
										<Assistant
											label="Briefing"
											text="The system is healthy. Your next meeting starts in 20 minutes."
											onRefresh={control}
										/>
									) : type === 'transcribe' ? (
										<TranscribeView
											label="Translate"
											mode="translate"
											output="The meeting starts at two."
											source="La réunion commence à deux heures."
											onToggle={control}
										/>
									) : (
										<TimerView label="Focus" time="24:30" onToggle={control} onReset={control} />
									)}
								</div>
								<figcaption>{type}</figcaption>
							</figure>
						))}
					</div>
				</section>
			))}
		</TelemetryHubContext.Provider>
	);
}
