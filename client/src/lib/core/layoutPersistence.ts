import { desktopMonitor, editedLibrary, type EditorMode } from './editorMode';
// Pure layout write planning. The backend still merges touched fields atomically at commit time.
import { emptyMonitorLayout, type Library, type LayoutV2, type MonitorLayout } from './layoutTree';
export type Baseline = {
	monitor: MonitorLayout;
	library: Library | undefined;
	theme: string;
	themeLock: boolean;
	/** Saved global inherit-theme, distinct from `theme` when per-monitor themes are unlocked. */
	globalTheme?: string;
	tokens: Record<string, string>;
};

/** A floating leaf queued for ANOTHER monitor's layout (a cross-monitor move), merged on Save. */
export type Extra = { key: string; leaf: import('./layoutTree').Leaf };

export type PersistView = {
	myMonitor: string;
	monitor: MonitorLayout;
	library: Library | undefined;
	selectedTheme: string;
	themeLock: boolean;
	globalTheme: string | undefined;
	tokenOverrides: Record<string, string>;
	mode: EditorMode;
	savedBaseline: Baseline | null;
};

type GlobalField = 'library' | 'theme' | 'themeLock' | 'tokens';

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

function touchedGlobals(
	current: Pick<PersistView, 'selectedTheme' | 'themeLock' | 'tokenOverrides'> & {
		library: Library | undefined;
	},
	baseline: Baseline | null
): GlobalField[] {
	if (!baseline) return ['library', 'theme', 'themeLock', 'tokens'];
	const touched: GlobalField[] = [];
	if (!sameJson(current.library, baseline.library)) touched.push('library');
	if (current.themeLock !== baseline.themeLock) {
		touched.push('theme', 'themeLock');
	} else if (current.themeLock && current.selectedTheme !== baseline.theme) {
		touched.push('theme');
	}
	if (!sameJson(current.tokenOverrides, baseline.tokens)) touched.push('tokens');
	return touched;
}

export type LayoutFile = {
	monitors: LayoutV2['monitors'];
	fileLib: Library | undefined;
	fileTheme: string | undefined;
	recoverCorrupt: boolean;
};

export type LayoutDocument = LayoutV2 & {
	library?: Library;
	theme?: string;
	themeLock?: false;
	tokens?: Record<string, string>;
};
export type LayoutWritePlan = {
	document: LayoutDocument;
	touchedMonitors: string[];
	touchedGlobals: GlobalField[];
	recoverCorrupt?: true;
};

function assemble(
	file: LayoutFile,
	key: string,
	snapshot: Baseline,
	fields: GlobalField[],
	globalTheme: string | undefined,
	extras: Extra[] = []
): LayoutWritePlan {
	const monitor = { ...snapshot.monitor };
	delete monitor.theme;
	if (!snapshot.themeLock) monitor.theme = snapshot.theme;
	const monitors = { ...file.monitors, [key]: monitor };
	for (const extra of extras) {
		if (extra.key === key) continue;
		const target = monitors[extra.key] ?? emptyMonitorLayout();
		monitors[extra.key] = { ...target, floating: [...target.floating, extra.leaf] };
	}
	const document: LayoutDocument = { version: 2, monitors };
	if (snapshot.library !== undefined) document.library = snapshot.library;
	else if (!fields.includes('library') && file.fileLib) document.library = file.fileLib;
	if (globalTheme) document.theme = globalTheme;
	if (!snapshot.themeLock) document.themeLock = false;
	if (Object.keys(snapshot.tokens).length) document.tokens = snapshot.tokens;
	return {
		document,
		touchedMonitors: [...new Set([key, ...extras.map((e) => e.key)])],
		touchedGlobals: fields,
		...(file.recoverCorrupt ? { recoverCorrupt: true as const } : {})
	};
}

export function planLayoutSave(
	file: LayoutFile,
	view: PersistView,
	extras: Extra[]
): LayoutWritePlan {
	const library = editedLibrary(view);
	const fields = touchedGlobals({ ...view, library }, view.savedBaseline);
	const snapshot: Baseline = {
		monitor: desktopMonitor(view),
		library,
		theme: view.selectedTheme,
		themeLock: view.themeLock,
		tokens: view.tokenOverrides
	};
	return assemble(
		file,
		view.myMonitor,
		snapshot,
		fields,
		fields.includes('theme') && view.themeLock ? view.selectedTheme : file.fileTheme,
		extras
	);
}

export function planLayoutRevert(
	file: LayoutFile,
	baseline: Baseline,
	key: string,
	current: PersistView
): LayoutWritePlan {
	const fields = touchedGlobals({ ...current, library: editedLibrary(current) }, baseline);
	const theme = fields.includes('theme')
		? baseline.themeLock
			? baseline.theme
			: (baseline.globalTheme ?? file.fileTheme)
		: file.fileTheme;
	return assemble(file, key, baseline, fields, theme);
}
