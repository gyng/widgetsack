import { useCatalogFavourites } from './useCatalogFavourites';
import {
	useEffect,
	useId,
	useRef,
	useState,
	type ReactNode,
	type DragEvent as ReactDragEvent
} from 'react';
import { createPortal } from 'react-dom';
import { useFocusTrap } from './canvas/useFocusTrap';
import { definitionReaches } from '../core/groupReferences';
import { getMeta } from '../core/widget';
import type { WidgetDef } from '../core/layoutTree';
import { BUILTIN_TEMPLATE_GROUP, resolveTemplateOptions, type Template } from '../core/templates';
import { useTemplateGroups } from './useTemplateGroups';
import { usePalettePreview, type PalettePreviewSpec } from './usePalettePreview';
import PaletteSection from './PaletteSection';
import PalettePreview from './PalettePreview';
import CatalogEntryButton from './CatalogEntryButton';
import CatalogViewToggle from './CatalogViewToggle';
import InspectorViewTabs from './InspectorViewTabs';
import WidgetIcon from './WidgetIcon';
import Select from './Select';
import Icon from './Icon';
import type { LayoutOp } from './ops';
import './WidgetCatalog.css';
// Group palette entries by `category` in first-seen order, uncategorized last under "Other".
// Pure (exported for tests): order within a group is registration order, same as before grouping.
export type PaletteEntry = { type: string; label: string; category?: string };
export function groupPalette(items: PaletteEntry[]): { category: string; items: PaletteEntry[] }[] {
	const groups = new Map<string, PaletteEntry[]>();
	for (const it of items) {
		const category = it.category ?? 'Other';
		const key = category === 'Utility' ? 'Utilities' : category === 'System' ? 'Tools' : category;
		const list = groups.get(key);
		if (list) list.push(it);
		else groups.set(key, [it]);
	}
	const ordered = Array.from(groups.entries()).map(([category, list]) => ({
		category,
		items: list
	}));
	// "Other" sinks to the end regardless of when the first uncategorized entry appeared.
	return ordered.sort((a, b) => Number(a.category === 'Other') - Number(b.category === 'Other'));
}

// A small "jump to the designer's read-only preview" affordance next to a template entry. The
// preview itself is the existing previewTemplate path (useDefEditor → the design canvas); this is
// just the door to it from the Add palette.
function TemplatePreviewButton({ t, onPreview }: { t: Template; onPreview: (id: string) => void }) {
	return (
		<button
			type="button"
			className="tpl-preview"
			title={`Preview ${t.name} in the widget builder (read-only)`}
			aria-label={`Preview ${t.name} in the widget builder`}
			onClick={() => onPreview(t.id)}
		>
			<Icon name="eye" />
		</button>
	);
}

// Templates share one catalog card. ParamSpecs open in a focused setup dialog; drafts
// survive cancellation, and insertion uses the same params as a cloned definition.
function TemplateOptionsForm({
	t,
	onInsert,
	onPreview,
	showPreview,
	hidePreview,
	tiles = false,
	extra
}: {
	extra?: ReactNode;
	tiles?: boolean;
	t: Template;
	onInsert: (options: Record<string, string>) => void;
	onPreview?: (templateId: string) => void;
	showPreview: (spec: PalettePreviewSpec, el: HTMLElement) => void;
	hidePreview: () => void;
}) {
	const [opts, setOpts] = useState<Record<string, string>>(() => resolveTemplateOptions(t));
	const [open, setOpen] = useState(false);
	const trigger = useRef<HTMLButtonElement>(null);
	const dialog = useRef<HTMLDivElement>(null);
	const titleId = useId();
	const { onKeyDown } = useFocusTrap(dialog, open);
	useEffect(() => {
		if (!open) return;
		dialog.current!.querySelector<HTMLElement>('input, [role="combobox"]')!.focus();
		const button = trigger.current!;
		return () => button.focus();
	}, [open]);
	return (
		<span className="libitem catalog-entry template-options-card">
			{tiles && <PalettePreview node={t.tree()} size={t.size} />}
			<CatalogEntryButton
				buttonRef={trigger}
				hasPopup="dialog"
				ariaLabel={`Set up ${t.name}`}
				spec={{
					label: t.name,
					desc: t.description,
					hint: 'Click to set up this template',
					node: t.tree(),
					size: t.size
				}}
				showPreview={showPreview}
				hidePreview={hidePreview}
				onActivate={() => setOpen(true)}
			/>
			{extra}
			{onPreview && <TemplatePreviewButton t={t} onPreview={onPreview} />}
			{open &&
				createPortal(
					<div className="template-setup-backdrop">
						<div
							ref={dialog}
							className="inspector template-setup"
							role="dialog"
							aria-modal="true"
							aria-labelledby={titleId}
							onKeyDown={(event) => {
								if (event.key === 'Escape' && !event.defaultPrevented) {
									event.preventDefault();
									event.stopPropagation();
									setOpen(false);
								} else onKeyDown(event);
							}}
						>
							<div className="tpl-opts">
								<span className="tpl-opts-head" id={titleId}>
									<span className="tpl-opts-name catalog-item-name">
										<WidgetIcon type="group" />
										Set up {t.name}
									</span>
								</span>
								<p className="template-setup-description">{t.description}</p>
								<div className="tpl-opts-fields">
									{/* All registered templates normalize params to an array. */}
									{t.params!.map((p) => (
										<label key={p.key}>
											{p.label ?? p.key}
											{p.choices ? (
												<Select
													value={opts[p.key]}
													options={p.choices}
													onChange={(v) => setOpts((prev) => ({ ...prev, [p.key]: v }))}
													aria-label={t.name + ' — ' + (p.label ?? p.key)}
												/>
											) : (
												<input
													value={opts[p.key]}
													onChange={(e) => {
														const value = e.currentTarget.value;
														setOpts((prev) => ({ ...prev, [p.key]: value }));
													}}
													aria-label={t.name + ' — ' + (p.label ?? p.key)}
												/>
											)}
										</label>
									))}
								</div>
								<p className="template-setup-description">
									Adds a standalone copy. You can change these options later.
								</p>
								<div className="template-setup-actions">
									<button type="button" onClick={() => setOpen(false)}>
										Cancel
									</button>
									<button
										type="button"
										className="tpl-opts-insert"
										title={`${t.description} — inserts a standalone copy onto the canvas (not saved as a custom widget)`}
										onClick={() => {
											onInsert(opts);
											setOpen(false);
										}}
									>
										Add to layout
									</button>
								</div>
							</div>
						</div>
					</div>,
					document.body
				)}
		</span>
	);
}

export type WidgetCatalogProps = {
	request?: { tab: string };
	widgetTypes?: PaletteEntry[];
	defs?: WidgetDef[];
	editingDefId?: string | null;
	workspace?: boolean;
	paletteSetup?: Record<string, ReactNode>;
	addInto?: string | null;
	addTargetName?: string | null;
	addDest?: string;
	onClearAddTarget?: () => void;
	onOp?: (op: LayoutOp) => void;
	onDeleteDef?: (id: string, name: string) => void;
	onPreviewTemplate?: (id: string) => void;
	context?: 'layout' | 'build';
	selectedDefId?: string | null;
	previewName?: string | null;
	onNewFromTemplate?: (id: string) => void;
	onNewFromWidget?: (type: string) => void;
	onOpenDefinition?: (id: string) => void;
	renderDefinition?: (def: WidgetDef, primary: ReactNode) => ReactNode;
};
export default function WidgetCatalog({
	request,
	widgetTypes = [],
	defs = [],
	editingDefId = null,
	workspace = false,
	paletteSetup = {},
	addInto,
	addTargetName,
	addDest = 'floating',
	onClearAddTarget,
	onOp,
	onDeleteDef,
	onPreviewTemplate,
	context = 'layout',
	selectedDefId,
	previewName,
	onNewFromTemplate,
	onNewFromWidget,
	onOpenDefinition,
	renderDefinition
}: WidgetCatalogProps) {
	const build = context === 'build';
	const { favourites, toggle } = useCatalogFavourites();
	const favouriteOnly = (key: string) => paletteTab !== 'Favourites' || favourites.includes(key);
	const star = (key: string, name: string) => (
		<button
			type="button"
			className="catalog-favourite catalog-action"
			aria-label={`${favourites.includes(key) ? 'Remove' : 'Add'} ${name} ${favourites.includes(key) ? 'from' : 'to'} favourites`}
			aria-pressed={favourites.includes(key)}
			onClick={() => toggle(key)}
		>
			<span aria-hidden="true">{favourites.includes(key) ? '★' : '☆'}</span>
		</button>
	);

	const op = (value: LayoutOp) => onOp?.(value);
	const [paletteTab, setPaletteTab] = useState(build ? 'All' : 'Widgets');
	const [paletteTiles, setPaletteTiles] = useState(() => {
		try {
			return localStorage.getItem('widgetsack.palette.view') === 'tiles';
		} catch {
			return false;
		}
	});
	const { palettePreview, showPreview, hidePreview } = usePalettePreview(build ? 'right' : 'left');
	const templateGroups = useTemplateGroups();
	// Add-palette filter: one search box narrows widgets + templates + library by name/type/description.
	const [paletteFilter, setPaletteFilter] = useState('');
	useEffect(() => {
		if (request) {
			setPaletteTab(request.tab);
			setPaletteFilter('');
		}
	}, [request]);
	const pq = paletteFilter.trim().toLowerCase();
	const pmatch = (...parts: (string | undefined)[]): boolean =>
		!pq || parts.some((p) => p?.toLowerCase().includes(pq));
	const fWidgetGroups = groupPalette(
		widgetTypes.filter(
			(w) =>
				pmatch(w.label, w.type, getMeta(w.type)?.description) && favouriteOnly(`widget:${w.type}`)
		)
	);
	const fDefs = defs.filter(
		(d) =>
			pmatch(d.name) &&
			favouriteOnly(`definition:${d.id}`) &&
			!(!build && editingDefId && definitionReaches({ version: 1, defs }, d.id, editingDefId))
	);
	const fTemplateGroups = templateGroups
		.map((g) => ({
			...g,
			templates: g.templates.filter(
				(t) => pmatch(t.name, t.description) && favouriteOnly(`template:${t.id}`)
			)
		}))
		.filter((g) => g.templates.length);
	const paletteEmpty = !fWidgetGroups.length && !fDefs.length && !fTemplateGroups.length;

	return (
		<div className="widget-catalog" onWheel={hidePreview}>
			{palettePreview}{' '}
			<div className="catalog-tools">
				<div className="catalog-tab-row">
					{workspace &&
						(build ? (
							<div className="catalog-section-select">
								<Select
									aria-label="Catalog section"
									value={paletteTab}
									options={['All', 'Widgets', 'Templates', 'My widgets', 'Favourites'].map(
										(value) => ({ value, label: value })
									)}
									onChange={setPaletteTab}
								/>
							</div>
						) : (
							<InspectorViewTabs
								palette
								panelId="catalog-results"
								values={['All', 'Widgets', 'Templates', 'My widgets', 'Favourites']}
								active={paletteTab}
								onSelect={setPaletteTab}
							/>
						))}

					<div className="catalog-view-row">
						<CatalogViewToggle
							tiles={paletteTiles}
							onChange={(tiles) => {
								setPaletteTiles(tiles);
								try {
									localStorage.setItem('widgetsack.palette.view', tiles ? 'tiles' : 'rows');
								} catch {
									/* Keep this session usable. */
								}
							}}
						/>
					</div>
				</div>
				{addTargetName ? (
					<span className="add-target-chip">
						Adding into: {addTargetName}
						<button
							type="button"
							className="x"
							title="Stop adding into this container"
							aria-label="Clear add target"
							onClick={() => onClearAddTarget?.()}
						>
							✕
						</button>
					</span>
				) : null}
				{/* One search box narrows widgets + templates + My widgets at once — ~20 widgets plus
				    templates + custom widgets made find-by-scan slow. */}
				<input
					className="palette-filter"
					type="search"
					placeholder="Search widgets…"
					value={paletteFilter}
					onChange={(e) => setPaletteFilter(e.currentTarget.value)}
					aria-label={build ? 'Filter custom widgets and templates' : 'Filter the add palette'}
				/>
				{workspace && !build && (
					<small className="catalog-destination">Drag to place · Click adds {addDest}</small>
				)}
			</div>
			<div
				className="catalog-results"
				id={build ? 'build-catalog-results' : 'catalog-results'}
				role={build ? 'region' : workspace ? 'tabpanel' : undefined}
				aria-label={build ? `${paletteTab} catalog` : undefined}
				aria-labelledby={
					workspace && !build ? `inspector-tab-${encodeURIComponent(paletteTab)}` : undefined
				}
			>
				{/* My widgets: your saved custom widgets (insert a copy linked to the custom widget). */}
				{fDefs.length &&
				(!workspace ||
					paletteTab === 'My widgets' ||
					paletteTab === 'All' ||
					paletteTab === 'Favourites' ||
					!!pq) ? (
					<PaletteSection
						tiles={paletteTiles}
						id="my-widgets"
						label="My widgets"
						count={fDefs.length}
						searching={!!pq}
					>
						{fDefs.map((d) => {
							const primary = (
								<CatalogEntryButton
									className={build ? 'dl-label' : ''}
									ariaLabel={d.name}
									spec={{
										label: d.name,
										hint: build ? 'Click to edit this widget' : 'Click to add a linked copy',
										node: d.child,
										size: d.size
									}}
									showPreview={showPreview}
									hidePreview={hidePreview}
									onActivate={() =>
										build ? onOpenDefinition?.(d.id) : op({ op: 'insertWidget', defId: d.id })
									}
								/>
							);
							return (
								<span
									key={d.id}
									className={`libitem catalog-entry ${build ? 'dl-item' : ''} ${d.id === selectedDefId ? 'cur' : ''}`}
								>
									{paletteTiles && <PalettePreview node={d.child} size={d.size} />}
									{build && renderDefinition ? (
										renderDefinition(d, primary)
									) : (
										<>
											{primary}
											<button
												type="button"
												className="x"
												title="Delete this custom widget (only if unused)"
												aria-label={`Delete ${d.name} from My widgets`}
												onClick={() =>
													onDeleteDef
														? onDeleteDef(d.id, d.name)
														: op({ op: 'deleteDef', defId: d.id })
												}
											>
												✕
											</button>
										</>
									)}
									{star(`definition:${d.id}`, d.name)}
								</span>
							);
						})}
					</PaletteSection>
				) : null}

				{/* Templates: insert a STANDALONE inline copy (the designer rail's ⎘ clones one into an
				    editable custom widget instead). Preview opens to the designer's read-only preview. Groups
				    come from the registry: built-ins first, then one per enabled plugin package. */}
				{(!workspace ||
					paletteTab === 'Templates' ||
					paletteTab === 'All' ||
					paletteTab === 'Favourites' ||
					!!pq) &&
					fTemplateGroups.map((g) => (
						<PaletteSection
							tiles={paletteTiles}
							key={g.group}
							id={`templates:${g.group}`}
							label={g.group === BUILTIN_TEMPLATE_GROUP ? 'Templates' : `Templates · ${g.group}`}
							count={g.templates.length}
							searching={!!pq}
						>
							{g.templates.map((t) =>
								!build && t.params?.length ? (
									<TemplateOptionsForm
										showPreview={showPreview}
										hidePreview={hidePreview}
										tiles={paletteTiles}
										extra={star(`template:${t.id}`, t.name)}
										key={t.id}
										t={t}
										onInsert={(options) => op({ op: 'insertTemplate', templateId: t.id, options })}
										onPreview={onPreviewTemplate}
									/>
								) : (
									<span
										key={t.id}
										className={`libitem catalog-entry ${build ? 'dl-item dl-template' : ''} ${previewName === t.name ? 'cur' : ''}`}
									>
										{paletteTiles && <PalettePreview node={t.tree()} size={t.size} />}
										<CatalogEntryButton
											ariaLabel={
												build ? t.name : [t.name, t.description].filter(Boolean).join(' — ')
											}
											spec={{
												label: t.name,
												desc: t.description,
												hint: 'Click to insert a standalone copy',
												node: t.tree(),
												size: t.size
											}}
											showPreview={showPreview}
											hidePreview={hidePreview}
											onActivate={() =>
												build
													? onPreviewTemplate?.(t.id)
													: op({ op: 'insertTemplate', templateId: t.id })
											}
										/>
										{star(`template:${t.id}`, t.name)}
										{build ? (
											<button
												type="button"
												className="catalog-action dl-use"
												aria-label={`Use ${t.name} template`}
												title="Make an editable copy"
												onClick={() => onNewFromTemplate?.(t.id)}
											>
												<Icon name="copy" />
											</button>
										) : (
											onPreviewTemplate && (
												<TemplatePreviewButton t={t} onPreview={onPreviewTemplate} />
											)
										)}
									</span>
								)
							)}
						</PaletteSection>
					))}

				{/* Widgets, grouped by meta.category (first-seen order; uncategorized falls into "Other"). */}
				{(!workspace ||
					paletteTab === 'Widgets' ||
					paletteTab === 'All' ||
					paletteTab === 'Favourites' ||
					!!pq) &&
					fWidgetGroups.map((g) => (
						<PaletteSection
							tiles={paletteTiles}
							key={g.category}
							id={`widgets:${g.category}`}
							label={g.category}
							count={g.items.length}
							searching={!!pq}
							setup={paletteSetup[g.category]}
						>
							{g.items.map((w) => (
								<span key={w.type} className="catalog-widget-item">
									{paletteTiles && <PalettePreview type={w.type} />}
									<button
										key={w.type}
										type="button"
										draggable
										// No native `title` tooltip — the hover preview popover is the richer replacement
										// (both at once was redundant). The description stays as the aria-label for a11y.
										aria-label={[w.label, getMeta(w.type)?.description].filter(Boolean).join(' — ')}
										onClick={() => {
											hidePreview();
											if (build) onNewFromWidget?.(w.type);
											else op({ op: 'addWidget', widgetType: w.type });
										}}
										onMouseEnter={(e) =>
											showPreview(
												{
													label: w.label,
													desc: getMeta(w.type)?.description,
													hint: addInto
														? `Click to add into ${addInto} · drag to place`
														: 'Click to add · drag to place',
													type: w.type
												},
												e.currentTarget
											)
										}
										onMouseLeave={hidePreview}
										onDragStart={(e: ReactDragEvent) => {
											hidePreview();
											e.dataTransfer?.setData('text/x-widget-type', w.type);
										}}
									>
										<span className="catalog-item-name">
											<WidgetIcon type={w.type} />
											{w.label}
										</span>
									</button>
									{star(`widget:${w.type}`, w.label)}
								</span>
							))}
						</PaletteSection>
					))}

				{paletteEmpty ? (
					<div className="palette-empty" role="status">
						{paletteTab === 'Favourites' && !pq ? (
							'No favourites yet. Star a widget or template to keep it here.'
						) : (
							<>No matches for “{paletteFilter}”.</>
						)}
					</div>
				) : null}
				{workspace &&
					(paletteTab === 'My widgets' || (build && paletteTab === 'All')) &&
					!fDefs.length &&
					!pq && (
						<p className="palette-empty">
							{build
								? 'No custom widgets yet. Start from a template or a built-in widget.'
								: 'No saved widgets yet. Save a group as a custom widget to reuse it here.'}
						</p>
					)}
			</div>
		</div>
	);
}
