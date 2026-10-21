import type { CSSProperties, ReactNode } from 'react';
import { DESIGN_DENSITIES, designPresetTokens } from '../src/lib/core/designPresets';
import HaSensor from '../src/lib/widgets/meters/HaSensor';
import HaBinarySensor from '../src/lib/widgets/meters/HaBinarySensor';
import HaLight from '../src/lib/widgets/meters/HaLight';
import HaSwitch from '../src/lib/widgets/meters/HaSwitch';
import HaFan from '../src/lib/widgets/meters/HaFan';
import HaClimate from '../src/lib/widgets/meters/HaClimate';
import HaCover from '../src/lib/widgets/meters/HaCover';
import HaLock from '../src/lib/widgets/meters/HaLock';
import HaScene from '../src/lib/widgets/meters/HaScene';
import HaInput from '../src/lib/widgets/meters/HaInput';
import HaMediaPlayer from '../src/lib/widgets/meters/HaMediaPlayer';
import Ticker from '../src/lib/widgets/meters/Ticker';
import { makeHub } from './seed';

const control = () => {};
const entity = (state: string, attributes: Record<string, unknown> = {}) => ({ state, attributes });
const hub = makeHub();
const stockHistory = hub.sensor('stocks.NVDA.series').getSnapshot();
const samples: { id: string; w: number; h: number; content: ReactNode }[] = [
	{
		id: 'sensor',
		w: 150,
		h: 44,
		content: <HaSensor label="Temperature" value={entity('21.4', { unit_of_measurement: '°C' })} />
	},
	{
		id: 'binary',
		w: 150,
		h: 44,
		content: <HaBinarySensor label="Door" value={entity('on', { device_class: 'door' })} />
	},
	{
		id: 'light',
		w: 120,
		h: 56,
		content: (
			<HaLight
				label="Lamp"
				value={entity('on', { brightness: 204, supported_color_modes: ['brightness'] })}
				onControl={control}
			/>
		)
	},
	{
		id: 'switch',
		w: 120,
		h: 48,
		content: <HaSwitch label="Power" value={entity('on')} onControl={control} />
	},
	{
		id: 'fan',
		w: 150,
		h: 56,
		content: (
			<HaFan
				label="Fan"
				value={entity('on', { percentage: 65, oscillating: true })}
				onControl={control}
			/>
		)
	},
	{
		id: 'climate',
		w: 170,
		h: 92,
		content: (
			<HaClimate
				label="Thermostat"
				value={entity('heat', {
					current_temperature: 20.5,
					temperature: 22,
					hvac_modes: ['off', 'heat', 'cool'],
					fan_modes: ['auto', 'low', 'high'],
					fan_mode: 'auto'
				})}
				onControl={control}
			/>
		)
	},
	{
		id: 'cover',
		w: 150,
		h: 76,
		content: (
			<HaCover
				label="Blinds"
				value={entity('open', { current_position: 70 })}
				onControl={control}
			/>
		)
	},
	{
		id: 'lock',
		w: 120,
		h: 48,
		content: <HaLock label="Front door" value={entity('locked')} onControl={control} />
	},
	{
		id: 'scene',
		w: 130,
		h: 40,
		content: <HaScene label="Evening" value={entity('ready')} onControl={control} />
	},
	...(['input_boolean', 'input_button', 'input_select', 'input_number', 'input_text'] as const).map(
		(domain) => ({
			id: domain,
			w: 160,
			h: 48,
			content: (
				<HaInput
					label="Helper"
					value={{
						entity_id: `${domain}.demo`,
						state: domain === 'input_boolean' ? 'on' : domain === 'input_number' ? '42' : 'Home',
						attributes: { options: ['Home', 'Away'], min: 0, max: 100 }
					}}
					onControl={control}
				/>
			)
		})
	),
	{
		id: 'media',
		w: 240,
		h: 120,
		content: (
			<HaMediaPlayer
				label="Speakers"
				value={entity('playing', {
					media_title: 'Midnight Drive',
					media_artist: 'Night Signals',
					volume_level: 0.6
				})}
				onControl={control}
				art="/gallery/cover.png"
			/>
		)
	},
	{
		id: 'notice',
		w: 230,
		h: 64,
		content: <HaSensor label="Home Assistant" haStatus="unconfigured" />
	},
	{
		id: 'ticker',
		w: 180,
		h: 120,
		content: (
			<Ticker
				symbol="NVDA"
				sensors={{
					price: hub.sensor('stocks.NVDA.price').getSnapshot(),
					change: hub.sensor('stocks.NVDA.change').getSnapshot(),
					series: { ...stockHistory, value: { kind: 'series', value: stockHistory.history } },
					currency: hub.sensor('stocks.NVDA.currency').getSnapshot(),
					state: hub.sensor('stocks.NVDA.state').getSnapshot()
				}}
			/>
		)
	}
];

/** Seeded visual comparison; controls stay local and never call Home Assistant. */
export default function DensityGallery() {
	return (
		<>
			<h1>Widget density comparison</h1>
			<p>
				Controls use seeded data. Larger densities need larger authored boxes; saved layouts retain
				their dimensions.
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
						style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 420px), 1fr))' }}
					>
						{samples.map((sample) => (
							<figure className="cell" key={sample.id}>
								<div
									className="density-meter"
									data-meter={sample.id}
									style={{
										width: Math.ceil(sample.w * [1, 1.25, 1.65][index]),
										height: Math.ceil(sample.h * [1, 1.3, 1.65][index]),
										fontSize: 'var(--np-text-body)',
										lineHeight: 'var(--np-line-body)'
									}}
								>
									{sample.content}
								</div>
								<figcaption>{sample.id}</figcaption>
							</figure>
						))}
					</div>
				</section>
			))}
		</>
	);
}
