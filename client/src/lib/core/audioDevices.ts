// Pure shaping for the Audio Switcher widget. No React/Tauri — unit-tested. The backend
// (widgetsack/src/audio.rs) lists render endpoints (`list_audio_outputs`) and reports/sets the default
// (`default_audio_output` / `set_default_audio_output`); this just decorates the list for display.

export type AudioDevice = { id: string; name: string };
export type AudioDeviceRow = AudioDevice & { active: boolean };

/** Decorate each device with whether it's the current default, the active one first so it reads as
 * "now playing through X, tap another to switch". Stable sort otherwise (keeps backend order). Pure. */
export function audioDeviceRows(
	devices: AudioDevice[],
	currentId: string | null
): AudioDeviceRow[] {
	const rows = devices.map((d) => ({ ...d, active: d.id === currentId }));
	return rows.sort((a, b) => Number(b.active) - Number(a.active));
}
