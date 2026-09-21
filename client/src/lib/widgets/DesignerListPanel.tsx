// Widget-designer section (extracted from Canvas): the My-widgets list (edit/rename/clone/delete),
// the template list (preview/clone), the AI-handoff "copy widget reference" button, and the
// empty-state explainer shown when no custom widget is open. The def-edit actions live in Canvas
// (canvas/useDefEditor) and arrive as one grouped prop. Renaming is inline — the open widget's name
// is an editable field in the list header, and ✎ on any row turns that row's name into a field —
// so there is no prompt(). Lazy-loaded like the other studio panels.
import { useState, type KeyboardEvent } from 'react';
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
	// The row whose name is currently an inline field (✎), if any.
	const [renamingId, setRenamingId] = useState<string | null>(null);
	// The "copy widget reference" outcome, shown inline under the button (no alert()).
	const [copyStatus, setCopyStatus] = useState<'copied' | 'failed' | null>(null);
	const editingDef = editingDefId ? library?.defs.find((d) => d.id === editingDefId) : undefined;
	return (
		<>
			<div className="designer-list">
				<button type="button" className="dl-new" onClick={actions.startNewWidget}>
					＋ New custom widget
				</button>
				<button
					type="button"
					className="dl-ref"
					title="Copy a Markdown reference of every widget type + its config schema — for handing to an AI assistant"
					onClick={async () => {
						const md = widgetReferenceMarkdown(listMetas());
						const ok = await copyToClipboard(md);
						if (!ok) console.log(md);
						setCopyStatus(ok ? 'copied' : 'failed');
					}}
				>
					⧉ Copy widget reference
				</button>
				{copyStatus && (
					<div className="rp-stub dl-copy-status" role="status">
						{copyStatus === 'copied'
							? 'Widget reference (Markdown) copied — paste it to the assistant.'
							: 'Copy failed; the reference was logged to the devtools console.'}
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
				<div className="rp-hd">My widgets</div>
				{library?.defs.length ? (
					<div className="dl-items">
						{library.defs.map((d) => (
							<div
								key={d.id}
								className={['dl-item', d.id === editingDefId && 'cur'].filter(Boolean).join(' ')}
							>
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
										<button
											type="button"
											className="dl-label"
											title="Edit this custom widget"
											onClick={() => actions.openExistingDef(d.id)}
										>
											{d.name}
										</button>
										<button
											type="button"
											className="dl-icon"
											title="Rename custom widget"
											onClick={() => setRenamingId(d.id)}
										>
											✎
										</button>
									</>
								)}
								<button
									type="button"
									className="dl-icon"
									title="Clone to a new custom widget"
									onClick={() => actions.cloneDefToEdit(d.id)}
								>
									⎘
								</button>
								<button
									type="button"
									className="dl-icon dl-del"
									title="Delete custom widget"
									onClick={() => actions.deleteWidget(d.id, d.name)}
								>
									✕
								</button>
							</div>
						))}
					</div>
				) : (
					<div className="rp-stub">No custom widgets yet — ＋ New, or clone a template.</div>
				)}
				{/* One section per registry group: built-ins, then each enabled plugin package. */}
				{templateGroups.map((g) => (
					<div key={g.group}>
						<div className="rp-hd">
							{g.group === BUILTIN_TEMPLATE_GROUP ? 'Templates' : `Templates · ${g.group}`}
						</div>
						<div className="dl-items">
							{g.templates.map((t) => (
								<div
									key={t.id}
									className={['dl-item', previewName === t.name && 'cur'].filter(Boolean).join(' ')}
								>
									<button
										type="button"
										className="dl-label"
										title={`${t.description} — click to preview (read-only)`}
										onClick={() => actions.previewTemplate(t.id)}
									>
										{t.name}
									</button>
									<button
										type="button"
										className="dl-icon"
										title="Clone into a new editable custom widget — its copies keep the template's options as parameters (the Layout section's Add palette inserts standalone copies instead)"
										onClick={() => actions.newFromTemplate(t.id)}
									>
										⎘
									</button>
								</div>
							))}
						</div>
					</div>
				))}
			</div>
			{!designing && (
				<div className="designer-empty">
					<div className="de-title">Widget designer</div>
					<div className="de-hint">
						Build a reusable <strong>custom widget</strong> — its inner layout, sensors, and styling
						— once, then drop copies of it onto any monitor.
						<br />
						<br />
						Pick a custom widget on the left to edit, clone a template, or ＋&nbsp;New custom widget
						to start from scratch.
						<br />
						<br />
						Just placing a widget (CPU, clock, …) on your desktop? That’s the{' '}
						<strong>Layout</strong> section — pick a spot, then use the “Add” palette.
					</div>
				</div>
			)}
		</>
	);
}
