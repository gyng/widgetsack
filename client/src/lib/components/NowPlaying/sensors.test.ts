import { describe, expect, it } from 'vitest';
import type { SessionRecord } from '../../../stores/stores';
import { mediaSensorSamples, NP_SENSOR_IDS } from './sensors';

type Over = {
	source?: string;
	title?: string;
	artist?: string;
	albumTitle?: string;
	status?: string;
	shuffle?: boolean;
	repeat?: 'None' | 'Track' | 'List';
	position?: number;
	end?: number;
};

// A SessionModel (the shape both Media[0] and Model carry) from the given fields.
const sessionModel = (over: Over): NonNullable<SessionRecord['last_model_update']>['Model'] => ({
	source: over.source ?? 'spotify.exe',
	playback: {
		auto_repeat: over.repeat ?? 'None',
		rate: 1,
		shuffle: over.shuffle ?? false,
		status: (over.status ?? 'Playing') as never,
		type: 'Music'
	},
	timeline:
		over.position !== undefined || over.end !== undefined
			? { start: 0, end: over.end ?? 0, position: over.position ?? 0, last_updated_at_ms: 0 }
			: null,
	media: {
		album: over.albumTitle ? { artist: '', title: over.albumTitle, track_count: 0 } : null,
		artist: over.artist ?? '',
		genres: [],
		playback_type: 'Music',
		subtitle: '',
		title: over.title ?? '',
		track_number: null
	}
});

// Build a SessionRecord whose Media[0] carries the given media/playback/timeline. `model` (when
// given) is the LIVE model update, as the bridge delivers on play/pause/seek; otherwise the record
// has no model update yet (the media copy is the only playback state).
const make = (over: Over, model?: Over): SessionRecord => ({
	session_id: 1,
	source: over.source ?? 'spotify.exe',
	timestamp_created: null,
	timestamp_updated: null,
	last_media_update: { Media: [sessionModel(over), null] },
	last_model_update: model ? { Model: sessionModel(model) } : null
});

// Convenience: id -> SensorValue, for terse assertions.
const byId = (session: SessionRecord | undefined) =>
	Object.fromEntries(mediaSensorSamples(session, 123).map((s) => [s.sensor, s.value]));

describe('mediaSensorSamples', () => {
	it('emits exactly NP_SENSOR_IDS, in order, stamped with the given ts', () => {
		const samples = mediaSensorSamples(undefined, 123);
		expect(samples.map((s) => s.sensor)).toEqual(NP_SENSOR_IDS);
		expect(samples.every((s) => s.ts_ms === 123)).toBe(true);
	});

	it('yields empty text + zeroed scalars when nothing is playing', () => {
		const v = byId(undefined);
		expect(v['np.title']).toEqual({ kind: 'text', value: '' });
		expect(v['np.status']).toEqual({ kind: 'text', value: '' });
		expect(v['np.playing']).toEqual({ kind: 'scalar', value: 0 });
		expect(v['np.position']).toEqual({ kind: 'scalar', value: 0 });
		expect(v['np.progress']).toEqual({ kind: 'scalar', value: 0 });
	});

	it('maps a playing session with a timeline to the right values', () => {
		const v = byId(
			make({
				source: 'foobar2000.exe',
				title: 'Track',
				artist: 'Artist',
				albumTitle: 'Album',
				status: 'Playing',
				shuffle: true,
				repeat: 'Track',
				position: 30,
				end: 120
			})
		);
		expect(v['np.title']).toEqual({ kind: 'text', value: 'Track' });
		expect(v['np.artist']).toEqual({ kind: 'text', value: 'Artist' });
		expect(v['np.album']).toEqual({ kind: 'text', value: 'Album' });
		expect(v['np.source']).toEqual({ kind: 'text', value: 'foobar2000.exe' });
		expect(v['np.status']).toEqual({ kind: 'text', value: 'Playing' });
		expect(v['np.playing']).toEqual({ kind: 'scalar', value: 1 });
		expect(v['np.position']).toEqual({ kind: 'scalar', value: 30 });
		expect(v['np.duration']).toEqual({ kind: 'scalar', value: 120 });
		expect(v['np.progress']).toEqual({ kind: 'scalar', value: 25 });
		expect(v['np.shuffle']).toEqual({ kind: 'scalar', value: 1 });
		expect(v['np.repeat']).toEqual({ kind: 'text', value: 'Track' });
	});

	it('reads playback + timeline from the LIVE model update, metadata from the media update', () => {
		// The media update's playback copy goes stale after a pause/seek: only the model update moves.
		const v = byId(
			make(
				{
					title: 'Track',
					status: 'Playing',
					position: 10,
					end: 100,
					shuffle: false,
					repeat: 'None'
				},
				{ title: 'stale', status: 'Paused', position: 50, end: 100, shuffle: true, repeat: 'List' }
			)
		);
		expect(v['np.title']).toEqual({ kind: 'text', value: 'Track' });
		expect(v['np.status']).toEqual({ kind: 'text', value: 'Paused' });
		expect(v['np.playing']).toEqual({ kind: 'scalar', value: 0 });
		expect(v['np.position']).toEqual({ kind: 'scalar', value: 50 });
		expect(v['np.progress']).toEqual({ kind: 'scalar', value: 50 });
		expect(v['np.shuffle']).toEqual({ kind: 'scalar', value: 1 });
		expect(v['np.repeat']).toEqual({ kind: 'text', value: 'List' });
	});

	it('np.playing is 0 when paused; np.progress is 0 with no timeline', () => {
		const v = byId(make({ status: 'Paused' }));
		expect(v['np.playing']).toEqual({ kind: 'scalar', value: 0 });
		expect(v['np.progress']).toEqual({ kind: 'scalar', value: 0 });
		expect(v['np.duration']).toEqual({ kind: 'scalar', value: 0 });
	});
});
