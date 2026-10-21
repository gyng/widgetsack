// Offline specimens for widgets whose containers would otherwise contact devices or providers.
import MonitorSwitch from './meters/MonitorSwitch';
import Volume from './meters/Volume';
import Assistant from './meters/Assistant';
import AiChat from './meters/AiChat';
import AudioSwitcher from './meters/AudioSwitcher';
import AudioMixer from './meters/AudioMixer';
import ServiceHealth from './meters/ServiceHealth';
import WidgetIcon from './WidgetIcon';
import './PreviewSample.css';

const TYPES = new Set([
	'nowplaying',
	'ha.media_player',
	'spectrum',
	'assistant',
	'aichat',
	'transcribe',
	'monitorswitch',
	'audioswitch',
	'volume',
	'image',
	'iframe',
	'audiomixer',
	'servicehealth',
	'spacer'
]);
export const needsOfflinePreview = (type: string): boolean => TYPES.has(type);
const noop = () => {};

export default function PreviewSample({ type }: { type: string }) {
	let content;
	switch (type) {
		case 'volume':
			content = <Volume level={0.65} muted={false} />;
			break;
		case 'monitorswitch':
			content = (
				<MonitorSwitch
					title="Primary monitor"
					compact
					rows={[
						{ value: 15, label: 'DisplayPort', active: true },
						{ value: 17, label: 'HDMI', active: false }
					]}
					onPick={noop}
				/>
			);
			break;
		case 'audioswitch':
			content = (
				<AudioSwitcher
					devices={[
						{ id: 'speakers', name: 'Speakers' },
						{ id: 'headphones', name: 'Headphones' }
					]}
					currentId="speakers"
					onPick={noop}
				/>
			);
			break;
		case 'assistant':
			content = (
				<Assistant
					label="Daily briefing"
					text="Your system is running smoothly. Two events are on your agenda today."
				/>
			);
			break;
		case 'aichat':
			content = (
				<AiChat
					label="AI Chat"
					turns={[]}
					input="Summarize my day"
					busy={false}
					onInput={noop}
					onSend={noop}
					onStop={noop}
					onClear={noop}
				/>
			);
			break;
		case 'audiomixer':
			content = (
				<AudioMixer
					snapshot={{
						sessions: [{ id: 'music', name: 'Music', level: 0.6, muted: false }],
						microphone: { level: 0.8, muted: false }
					}}
					error=""
					busy={false}
					showMicrophone
					editMode
					onLevel={noop}
					onMute={noop}
					onMicrophone={noop}
				/>
			);
			break;
		case 'servicehealth':
			content = (
				<ServiceHealth
					result={{ status: 200, latencyMs: 24, certificateDays: 90, error: null }}
					label="Service health"
					url="https://example.invalid"
					slowMs={1000}
					warnDays={14}
					busy={false}
				/>
			);
			break;
		case 'spectrum':
			content = (
				<svg className="sample-spectrum" viewBox="0 0 200 100" aria-label="Sample spectrum">
					{Array.from({ length: 24 }, (_, i) => {
						const height = 15 + 60 * Math.abs(Math.sin(i * 0.47));
						return (
							<rect
								key={i}
								x={i * 8 + 4}
								y={100 - height}
								width="5"
								height={height}
								fill="currentColor"
							/>
						);
					})}
				</svg>
			);
			break;
		case 'image':
			content = (
				<svg className="sample-image" viewBox="0 0 200 110" aria-label="Sample image">
					<rect width="200" height="110" fill="#18354a" />
					<circle cx="150" cy="30" r="16" fill="#ffd58c" />
					<path d="M0 110L55 35l55 75z" fill="#78b4ba" />
					<path d="M60 110l75-55 65 55z" fill="#467d89" />
				</svg>
			);
			break;
		case 'ha.media_player':
		case 'nowplaying':
			content = (
				<div className="sample-media">
					<span className="sample-cover">
						<WidgetIcon type="nowplaying" />
					</span>
					<strong>Sample track</strong>
					<span>Sample artist</span>
				</div>
			);
			break;
		case 'iframe':
			content = (
				<div className="sample-web">
					<strong>
						<WidgetIcon type="iframe" /> Example webpage
					</strong>
					<span className="sample-web-line" />
					<span className="sample-web-line" />
					<span className="sample-web-line" />
				</div>
			);
			break;
		case 'transcribe':
			content = (
				<div className="sample-copy">
					<strong>
						<WidgetIcon type="transcribe" /> Transcribe
					</strong>
					<p>Your spoken words appear here.</p>
				</div>
			);
			break;
		default:
			content = (
				<div className="sample-copy">
					<WidgetIcon type="spacer" />
					<p>A flexible gap between widgets.</p>
				</div>
			);
	}
	return (
		<div className="widget-preview-sample" data-preview-sample={type}>
			{content}
		</div>
	);
}
