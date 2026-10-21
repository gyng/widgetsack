import { createWidget, getMeta } from '../../core/widget';
import { leaf } from '../../core/layoutTree';
import type { Action } from '../../core/editorReducer';
import type { WidgetDef } from '../../core/layoutTree';
import { getTemplate } from '../../core/templates';
import { clone, rand, freshIds } from './editorOps';

// Build a fresh WidgetDef from a template id: the template's flow TREE (defaults baked, ids
// remapped) becomes the def child at the template's declared size, and the template's ParamSpecs
// become the def's params — so a cloned clock still switches 12/24-hour per instance, instead of
// the options being silently dropped/baked. Shared by newFromTemplate (clone into the library) and
// previewTemplate (read-only preview, not stored).
function templateDef(templateId: string): WidgetDef | null {
	const t = getTemplate(templateId);
	if (!t) return null;
	return {
		id: `def-${rand()}`,
		name: t.name,
		size: t.size,
		child: freshIds(t.tree()),
		...(t.params ? { params: clone(t.params) } : {})
	};
}

export type EditorAction =
	| Exclude<Action, { type: 'newWidget' | 'cloneDef' | 'newFromTemplate' | 'previewTemplate' }>
	| { type: 'newWidget' }
	| { type: 'newFromWidget'; widgetType: string }
	| { type: 'cloneDef'; defId: string }
	| { type: 'newFromTemplate' | 'previewTemplate'; templateId: string };

/** Resolve fresh identities and template factories once, before React evaluates a reducer. */
export function prepareEditorAction(action: EditorAction): Action {
	switch (action.type) {
		case 'newFromWidget': {
			const meta = getMeta(action.widgetType);
			if (!meta) return { type: 'newFromTemplate', definition: null };
			const widget = createWidget(action.widgetType, `${action.widgetType}-${rand()}`);
			return {
				type: 'newFromTemplate',
				definition: {
					id: `def-${rand()}`,
					name: meta.label ?? meta.type,
					size: { w: widget.rect.w, h: widget.rect.h },
					child: leaf(widget)
				}
			};
		}
		case 'newWidget':
			return { ...action, id: `def-${rand()}`, name: `widget-${rand()}` };
		case 'cloneDef':
			return { ...action, id: `def-${rand()}` };
		case 'newFromTemplate':
		case 'previewTemplate':
			return { type: action.type, definition: templateDef(action.templateId) };
		default:
			return action;
	}
}
