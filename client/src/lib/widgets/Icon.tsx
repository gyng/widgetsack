// Shared stroke icons. The accessible name belongs to the enclosing control.
const paths = {
	external: 'M8 3h9v9M17 3l-9 9M5 5H3v12h12v-2',
	refresh: 'M17 7a7 7 0 1 0 0 6M17 2v5h-5',
	storm: 'M5 7a5 5 0 0 1 10 0 3 3 0 0 1 0 6H5a3 3 0 1 1 0-6M11 11l-4 5h4l-1 3 5-5h-4z',
	'moon-new': 'M10 2a8 8 0 1 1 0 16a8 8 0 1 1 0-16z',
	'moon-waxing-crescent': 'M10 2a8 8 0 0 1 0 16a13 8 0 0 0 0-16z',
	'moon-first-quarter': 'M10 2a8 8 0 0 1 0 16z',
	'moon-waxing-gibbous': 'M10 2a8 8 0 0 1 0 16a4 8 0 0 1 0-16z',
	'moon-full': 'M10 2a8 8 0 1 1 0 16a8 8 0 1 1 0-16z',
	'moon-waning-gibbous': 'M10 2a8 8 0 0 0 0 16a4 8 0 0 0 0-16z',
	'moon-last-quarter': 'M10 2a8 8 0 0 0 0 16z',
	'moon-waning-crescent': 'M10 2a8 8 0 0 0 0 16a13 8 0 0 1 0-16z',

	chart: 'M3 3v14h14M5 13l4-5 4 3 4-7',
	gauge: 'M3 14a7 7 0 1 1 14 0M10 12l4-5M5 14h10',
	bar: 'M3 5h14v3H3zM3 12h10v3H3z',
	text: 'M3 4h14M10 4v12M7 16h6',
	clock: 'M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0M10 5v5l3 2',
	calendar: 'M3 5h14v12H3zM6 3v4M14 3v4M3 9h14M6 12h2M12 12h2',
	chip: 'M5 5h10v10H5zM8 8h4v4H8zM7 2v3M13 2v3M7 15v3M13 15v3M2 7h3M2 13h3M15 7h3M15 13h3',
	gpu: 'M2 5h15v9H2zM6 9a2 2 0 1 0 4 0 2 2 0 0 0-4 0M13 7v5M5 14v3h9M17 6h1v10',
	battery: 'M3 5h12v10H3zM15 8h2v4M6 8v4M9 8v4',
	disk: 'M3 4h14v12H3zM3 12h14M13 14h1M6 7h8',
	process: 'M3 3h14v14H3zM3 7h14M6 10h2M11 10h3M6 14h8',
	network: 'M7 3h6v4H7zM2 13h6v4H2zM12 13h6v4h-6zM10 7v3M5 13v-3h10v3',
	ping: 'M3 10h3l2-5 4 10 2-5h3',
	wifi: 'M2 6a12 12 0 0 1 16 0M5 9a8 8 0 0 1 10 0M8 12a3 3 0 0 1 4 0M10 15h.01',
	wave: 'M3 8v4M6 5v10M10 2v16M14 5v10M17 8v4',
	web: 'M2 3h16v14H2zM2 7h16M5 5h.01M8 5h.01M8 10l-3 2 3 2M12 10l3 2-3 2',
	zone: 'M2 3h16v14H2zM8 3v14M8 10h10',
	speaker: 'M3 8h4l5-4v12l-5-4H3zM15 7a4 4 0 0 1 0 6',
	trash: 'M4 6h12M7 6V3h6v3M5 6l1 11h8l1-11M8 9v5M12 9v5',
	image: 'M2 3h16v14H2zM3 15l5-6 4 4 2-2 3 4M13 6h.01',
	note: 'M3 3h14v9l-5 5H3zM12 17v-5h5M6 7h8M6 10h4',
	spacer: 'M3 4v12M17 4v12M3 10h14M6 7l-3 3 3 3M14 7l3 3-3 3',
	timer: 'M8 2h4M10 2v3M15 4l2 2M16 11a6 6 0 1 1-12 0 6 6 0 0 1 12 0M10 7v4l2 2',
	monitor: 'M2 3h16v11H2zM10 14v3M6 17h8',
	alert: 'M10 2l8 15H2zM10 7v4M10 14h.01',
	health: 'M3 10h4l2-4 3 8 2-4h3M3 3h14v14H3z',
	mixer: 'M4 3v14M10 3v14M16 3v14M2 7h4M8 13h4M14 8h4',
	check: 'M3 4h3v3H3zM9 5h8M3 11l2 2 3-4M10 12h7M3 17h14',
	play: 'M5 3l12 7-12 7z',
	weather: 'M6 11a4 4 0 1 1 8 0M4 11a3 3 0 0 0 0 6h11a3 3 0 0 0 0-6zM10 1v2M2 5l2 1M16 5l2-1',
	sun: 'M14 10a4 4 0 1 1-8 0 4 4 0 0 1 8 0M10 1v2M10 17v2M1 10h2M17 10h2M4 4l1 1M15 15l1 1M4 16l1-1M15 5l1-1',
	air: 'M2 6h10a2 2 0 1 0-2-2M2 10h14a2 2 0 1 1-2 2M2 14h6a2 2 0 1 1-2 2',
	rss: 'M3 3a14 14 0 0 1 14 14M3 8a9 9 0 0 1 9 9M3 15h2v2H3z',
	chat: 'M3 3h14v10H8l-5 4zM6 7h8M6 10h5',
	mic: 'M8 3a2 2 0 0 1 4 0v7a2 2 0 0 1-4 0zM5 9v1a5 5 0 0 0 10 0V9M10 15v3M7 18h6',
	command: 'M2 3h16v14H2zM5 7l3 3-3 3M10 13h5',
	button: 'M3 5h14v10H3zM7 8l4 2-4 2z',
	light: 'M6 11a6 6 0 1 1 8 0l-1 2H7zM7 16h6M8 18h4',
	lock: 'M4 9h12v9H4zM6 9V6a4 4 0 0 1 8 0v3M10 12v3',
	pause: 'M6 3v14M14 3v14',
	stop: 'M4 4h12v12H4z',
	previous: 'M4 3v14M16 3L5 10l11 7z',
	next: 'M16 3v14M4 3l11 7L4 17z',
	mute: 'M2 8h4l5-4v12l-5-4H2zM14 7l4 6M18 7l-4 6',
	'speaker-low': 'M3 8h4l5-4v12l-5-4H3z',
	'speaker-high': 'M2 8h4l5-4v12l-5-4H2zM14 7a4 4 0 0 1 0 6M16 4a8 8 0 0 1 0 12',
	unlock: 'M4 9h12v9H4zM6 9V6a4 4 0 0 1 8-1M10 12v3',
	shuffle: 'M2 5h3l10 10h3M2 15h3l3-3M12 8l3-3h3M15 2l3 3-3 3M15 12l3 3-3 3',
	repeat: 'M4 5h11l3 3-3 3M18 8H4M16 15H5l-3-3 3-3M2 12h14',
	'repeat-one': 'M4 4h11l3 3-3 3M18 7H4M16 16H5l-3-3 3-3M2 13h14M9 8l2-1v6',
	bolt: 'M11 2L4 11h6l-1 7 7-10h-6z',
	globe: 'M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0M2 10h16M10 2c-5 5-5 11 0 16M10 2c5 5 5 11 0 16',
	eye: 'M1 10s3-6 9-6 9 6 9 6-3 6-9 6-9-6-9-6M13 10a3 3 0 1 1-6 0 3 3 0 0 1 6 0',
	palette:
		'M10 2a8 8 0 1 0 0 16h1a2 2 0 0 0 0-4h-1a2 2 0 0 1 0-4h5a3 3 0 0 0 3-3c0-3-4-5-8-5M6 6h.01M4 10h.01M7 14h.01M11 5h.01',
	moon: 'M14 2a8 8 0 1 0 4 12A8 8 0 0 1 14 2z',
	cloud: 'M5 8a5 5 0 0 1 10 0 4 4 0 0 1 0 8H5a4 4 0 1 1 0-8z',
	rain: 'M5 7a5 5 0 0 1 10 0 3 3 0 0 1 0 6H5a3 3 0 1 1 0-6M6 15l-1 3M11 15l-1 3M16 15l-1 3',
	snow: 'M10 2v16M3 6l14 8M3 14l14-8M7 3l3 3 3-3M7 17l3-3 3 3',
	fog: 'M5 5a5 5 0 0 1 10 0M3 8h14M2 12h16M4 16h12',
	sunrise: 'M5 12a5 5 0 0 1 10 0M2 13h16M2 17h16M10 2v6M7 5l3-3 3 3',
	sunset: 'M5 12a5 5 0 0 1 10 0M2 13h16M2 17h16M10 2v6M7 5l3 3 3-3',
	help: 'M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0M7 7a3 3 0 1 1 5 2l-2 2v1M10 15h.01',
	rescue:
		'M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0M14 10a4 4 0 1 1-8 0 4 4 0 0 1 8 0M4 4l3 3M13 13l3 3M4 16l3-3M13 7l3-3',
	settings:
		'M3 6l3-3 3 2h2l3-2 3 3-2 3v2l2 3-3 3-3-2H9l-3 2-3-3 2-3V9zM13 10a3 3 0 1 1-6 0 3 3 0 0 1 6 0',
	share: 'M4 9v8h12V9M10 13V2M6 6l4-4 4 4',
	plugin: 'M6 2v5M14 2v5M4 7h12v3a6 6 0 0 1-12 0zM10 16v2',
	menu: 'M3 5h14M3 10h14M3 15h14',
	group: 'M3 3h6v6H3zM11 3h6v6h-6zM3 11h6v6H3zM11 11h6v6h-6z'
};

export default function Icon({ name, size = '1em' }: { name: string; size?: number | string }) {
	return (
		<svg
			className="ui-icon"
			data-icon={name}
			viewBox="0 0 20 20"
			width={size}
			height={size}
			fill="none"
			stroke="currentColor"
			strokeWidth="1.5"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
			focusable="false"
			style={{ display: 'inline-block', verticalAlign: '-0.15em', flexShrink: 0 }}
		>
			<path
				fill={name.startsWith('moon-') && name !== 'moon-new' ? 'currentColor' : 'none'}
				d={paths[name as keyof typeof paths] ?? paths.help}
			/>
		</svg>
	);
}
