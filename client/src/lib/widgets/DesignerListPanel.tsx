import WidgetStartDialog from './WidgetStartDialog';
import WidgetCatalog from './WidgetCatalog';
// Widget-designer section (extracted from Canvas): the My-widgets list (edit/rename/clone/delete),
// the template list (preview/clone), the AI-handoff "copy widget reference" button, and the
// empty-state explainer shown when no custom widget is open. The def-edit actions live in Canvas
// (canvas/useDefEditor) and arrive as one grouped prop. Renaming is inline — the open widget's name
// is an editable field in the list header, and ✎ on any row turns that row's name into a field —
// so there is no prompt(). Lazy-loaded like the other studio panels.
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import Icon from './Icon';
import './DesignerListPanel.css';
import type { Library } from '../core/layoutTree';
import { listMetas } from '../core/widget';
import { widgetReferenceMarkdown } from '../core/widgetDocs';
import { copyToClipboard } from '../overlay';
import type { DefEditor } from './canvas/useDefEditor';

type Props = {
	library: Library | undefined;
	editingDefId: string | null;
	/** The previewed template's name (read-only preview), to highlight its row. Null = none. */
	previewName: string | null;
	/** Whether a custom widget / preview is open on the design canvas (hides the empty-state explainer). */
	designing: boolean;
	onNewFromWidget?: (type: string) => void;
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
	onNewFromWidget,
	actions
}: Props) {
	// The row whose name is currently an inline field (✎), if any.
	const [starting, setStarting] = useState(false);
	const [catalogRequest, setCatalogRequest] = useState<{ tab: string } | undefined>();
	const [renamingId, setRenamingId] = useState<string | null>(null);
	// The "copy widget reference" outcome, shown inline under the button (no alert()).
	const [copyStatus, setCopyStatus] = useState<'copied' | 'failed' | null>(null);
	const alive = useRef(true);
	useEffect(
		() => () => {
			alive.current = false;
		},
		[]
	);
	const editingDef = editingDefId ? library?.defs.find((d) => d.id === editingDefId) : undefined;
	return (
		<>
			{starting && (
				<WidgetStartDialog
					onClose={() => setStarting(false)}
					onChoose={(tab) => {
						setCatalogRequest({ tab });
						setStarting(false);
					}}
					onBlank={() => {
						setStarting(false);
						actions.startNewWidget();
					}}
				/>
			)}
			<div className="designer-list">
				<div className="dl-tools">
					<div className="dl-toolbar">
						<button
							type="button"
							className="dl-new"
							aria-label="New custom widget"
							onClick={() => setStarting(true)}
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
				</div>
				<WidgetCatalog
					request={catalogRequest}
					context="build"
					workspace
					defs={library?.defs}
					selectedDefId={editingDefId}
					previewName={previewName}
					onOpenDefinition={actions.openExistingDef}
					onPreviewTemplate={actions.previewTemplate}
					onNewFromTemplate={actions.newFromTemplate}
					widgetTypes={listMetas().map((m) => ({
						type: m.type,
						label: m.label ?? m.type,
						category: m.category
					}))}
					onNewFromWidget={onNewFromWidget}
					renderDefinition={(d, primary) => (
						<>
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
									{primary}
									<button
										type="button"
										className="dl-icon dl-rename"
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
								className="dl-icon dl-copy"
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
						</>
					)}
				/>
			</div>
			{!designing && (
				<div className="designer-empty">
					<div className="de-title">Build your widget</div>
					<div className="de-hint">
						Start with a template, a built-in widget, or a copy from My widgets. Your widget is
						saved to My widgets; add it to a monitor from Layout.
					</div>
					<button type="button" className="dl-create" onClick={() => setStarting(true)}>
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
