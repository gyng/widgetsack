import CatalogViewToggle from './CatalogViewToggle';
import PalettePreview from './PalettePreview';
// Widget-designer section (extracted from Canvas): the My-widgets list (edit/rename/clone/delete),
// the template list (preview/clone), the AI-handoff "copy widget reference" button, and the
// empty-state explainer shown when no custom widget is open. The def-edit actions live in Canvas
// (canvas/useDefEditor) and arrive as one grouped prop. Renaming is inline — the open widget's name
// is an editable field in the list header, and ✎ on any row turns that row's name into a field —
// so there is no prompt(). Lazy-loaded like the other studio panels.
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import Icon from './Icon';
import PaletteSection from './PaletteSection';
import CatalogEntryButton from './CatalogEntryButton';
import { usePalettePreview } from './usePalettePreview';
import './DesignerListPanel.css';
import { BUILTIN_TEMPLATE_GROUP } from '../core/templates';
import type { Library } from '../core/layoutTree';
import { listMetas } from '../core/widget';
import { widgetReferenceMarkdown } from '../core/widgetDocs';
import { copyToClipboard } from '../overlay';
import type { DefEditor } from './canvas/useDefEditor';
import { useTemplateGroups } from './useTemplateGroups';

type Props = {
	library: Library | undefined;
	editingDefId: string | null;
	/** The previewed template's name (read-only preview), to highlight its row. Null = none. */
	previewName: string | null;
	/** Whether a custom widget / preview is open on the design canvas (hides the empty-state explainer). */
	designing: boolean;
	actions: Pick<
		DefEditor,
		| 'startNewWidget'
		| 'openExistingDef'
		| 'renameWidget'
		| 'cloneDefToEdit'
		| 'deleteWidget'
		| 'previewTemplate'
		| 'newFromTemplate'
	>;
};

// An inline name field: commits on Enter / blur (a blank commit is the hook's no-op), cancels on
// Escape. `key` it on the name so an external rename (undo) re-seeds the draft.
function InlineName({
	name,
	ariaLabel,
	autoFocus,
	onCommit,
	onDone
}: {
	name: string;
	ariaLabel: string;
	autoFocus?: boolean;
	onCommit: (name: string) => void;
	/** Called after a commit or a cancel (a row field closes itself; the header field stays). */
	onDone?: () => void;
}) {
	const [draft, setDraft] = useState(name);
	const commit = () => {
		if (draft.trim() && draft.trim() !== name) onCommit(draft);
		onDone?.();
	};
	const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
		if (e.key === 'Enter') {
			e.preventDefault();
			e.currentTarget.blur(); // → onBlur commits once
		} else if (e.key === 'Escape') {
			e.preventDefault();
			setDraft(name);
			onDone?.();
		}
	};
	return (
		<input
			type="text"
			className="dl-name-input"
			value={draft}
			aria-label={ariaLabel}
			autoFocus={autoFocus}
			spellCheck={false}
			onChange={(e) => setDraft(e.currentTarget.value)}
			onKeyDown={onKey}
			onBlur={commit}
		/>
	);
}

export default function DesignerListPanel({
	library,
	editingDefId,
	previewName,
	designing,
	actions
}: Props) {
	// Built-ins + one group per enabled plugin package (re-renders on package toggle).
	const templateGroups = useTemplateGroups();
	const { palettePreview, showPreview, hidePreview } = usePalettePreview('right');
	// The row whose name is currently an inline field (✎), if any.
	const [renamingId, setRenamingId] = useState<string | null>(null);
	// The "copy widget reference" outcome, shown inline under the button (no alert()).
	const [copyStatus, setCopyStatus] = useState<'copied' | 'failed' | null>(null);
	const [filter, setFilter] = useState('');
	const [tiles, setTiles] = useState(() => {
		try {
			return localStorage.getItem('widgetsack.designer.view') === 'tiles';
		} catch {
			return false;
		}
	});
	const alive = useRef(true);
	useEffect(
		() => () => {
			alive.current = false;
		},
		[]
	);
	const editingDef = editingDefId ? library?.defs.find((d) => d.id === editingDefId) : undefined;
	const query = filter.trim().toLowerCase();
	const matches = (...text: string[]) => text.join(' ').toLowerCase().includes(query);
	const defs = (library?.defs ?? []).filter((d) => matches(d.name));
	const groups = templateGroups
		.map((g) => ({ ...g, templates: g.templates.filter((t) => matches(t.name, t.description)) }))
		.filter((g) => g.templates.length);
	return (
		<>
			{palettePreview}
			<div className="designer-list" onWheel={hidePreview}>
				<div className="dl-tools">
					<div className="dl-toolbar">
						<button
							type="button"
							className="dl-new"
							aria-label="New custom widget"
							onClick={actions.startNewWidget}
						>
							<Icon name="plus" /> New widget
						</button>
						<button
							type="button"
							className="dl-ref"
							aria-label="Copy widget reference"
							title="Copy a Markdown reference of every widget type + its config schema — for handing to an AI assistant"
							onClick={async () => {
								const md = widgetReferenceMarkdown(listMetas());
								const ok = await copyToClipboard(md);
								if (alive.current) setCopyStatus(ok ? 'copied' : 'failed');
							}}
						>
							<Icon name="copy" />
						</button>
					</div>
					<div className="dl-view-row">
						<CatalogViewToggle
							tiles={tiles}
							onChange={(value) => {
								hidePreview();
								setTiles(value);
								try {
									localStorage.setItem('widgetsack.designer.view', value ? 'tiles' : 'rows');
								} catch {
									/* Keep this session usable. */
								}
							}}
						/>
					</div>
					{copyStatus && (
						<div className="rp-stub dl-copy-status" role="status">
							{copyStatus === 'copied'
								? 'Widget reference (Markdown) copied — paste it to the assistant.'
								: 'Copy failed. Try again.'}
						</div>
					)}
					{editingDef && (
						<div className="dl-editing">
							<span className="rp-sub">Editing</span>
							<InlineName
								key={`${editingDef.id}:${editingDef.name}`}
								name={editingDef.name}
								ariaLabel="Custom widget name"
								onCommit={(name) => actions.renameWidget(editingDef.id, name)}
							/>
						</div>
					)}
					<input
						type="search"
						aria-label="Filter custom widgets and templates"
						placeholder="Filter widgets and templates…"
						value={filter}
						onChange={(event) => setFilter(event.target.value)}
					/>
				</div>
				<PaletteSection
					id="designer:my-widgets"
					label="My widgets"
					count={defs.length}
					searching={!!query}
					tiles={tiles}
				>
					{defs.length ? (
						<div className="dl-items">
							{defs.map((d) => (
								<div
									key={d.id}
									className={['dl-item catalog-entry', d.id === editingDefId && 'cur']
										.filter(Boolean)
										.join(' ')}
								>
									{tiles && <PalettePreview node={d.child} size={d.size} />}
									{renamingId === d.id ? (
										<InlineName
											key={d.name}
											name={d.name}
											ariaLabel={`Rename ${d.name}`}
											autoFocus
											onCommit={(name) => actions.renameWidget(d.id, name)}
											onDone={() => setRenamingId(null)}
										/>
									) : (
										<>
											<CatalogEntryButton
												className="dl-label"
												ariaLabel={d.name}
												spec={{
													label: d.name,
													hint: 'Click to edit this custom widget',
													node: d.child,
													size: d.size
												}}
												showPreview={showPreview}
												hidePreview={hidePreview}
												onActivate={() => actions.openExistingDef(d.id)}
											/>
											<button
												type="button"
												className="dl-icon"
												title="Rename custom widget"
												aria-label={`Rename ${d.name}`}
												onClick={() => setRenamingId(d.id)}
											>
												<Icon name="edit" />
											</button>
										</>
									)}
									<button
										type="button"
										className="dl-icon"
										title="Clone to a new custom widget"
										aria-label={`Duplicate ${d.name}`}
										onClick={() => actions.cloneDefToEdit(d.id)}
									>
										<Icon name="copy" />
									</button>
									<button
										type="button"
										className="dl-icon dl-del"
										title="Delete custom widget"
										aria-label={`Delete ${d.name}`}
										onClick={() => actions.deleteWidget(d.id, d.name)}
									>
										<Icon name="trash" />
									</button>
								</div>
							))}
						</div>
					) : !query ? (
						<div className="rp-stub">No custom widgets yet. Create one or use a template.</div>
					) : null}
				</PaletteSection>
				{/* One section per registry group: built-ins, then each enabled plugin package. */}
				{groups.map((g) => (
					<PaletteSection
						key={g.group}
						id={`designer:templates:${g.group}`}
						label={g.group === BUILTIN_TEMPLATE_GROUP ? 'Templates' : `Templates · ${g.group}`}
						count={g.templates.length}
						searching={!!query}
						tiles={tiles}
					>
						<div className="dl-items">
							{g.templates.map((t) => (
								<div
									key={t.id}
									className={['dl-item catalog-entry', previewName === t.name && 'cur']
										.filter(Boolean)
										.join(' ')}
								>
									{tiles && <PalettePreview node={t.tree()} size={t.size} />}
									<CatalogEntryButton
										className="dl-label"
										ariaLabel={t.name}
										spec={{
											label: t.name,
											desc: t.description,
											hint: 'Click to preview · Use template creates an editable copy',
											node: t.tree(),
											size: t.size
										}}
										showPreview={showPreview}
										hidePreview={hidePreview}
										onActivate={() => actions.previewTemplate(t.id)}
									/>
									<button
										type="button"
										className="dl-icon dl-use"
										title="Create an editable copy of this template"
										aria-label={`Use ${t.name} template`}
										onClick={() => actions.newFromTemplate(t.id)}
									>
										<Icon name="copy" />
										{tiles && <span>Use template</span>}
									</button>
								</div>
							))}
						</div>
					</PaletteSection>
				))}
				{query && !defs.length && !groups.length && (
					<p className="rp-stub" role="status">
						No matches for “{filter}”.
					</p>
				)}
			</div>
			{!designing && (
				<div className="designer-empty">
					<div className="de-title">Widget designer</div>
					<div className="de-hint">
						Create a reusable widget, then add copies to your monitor layouts. Choose a saved widget
						to edit, or preview a template and select <strong>Use template</strong>.
					</div>
					<button type="button" className="dl-create" onClick={actions.startNewWidget}>
						Create a custom widget
					</button>
					<p className="de-footnote">
						To place individual meters on your desktop, open Layout → Add.
					</p>
				</div>
			)}
		</>
	);
}
