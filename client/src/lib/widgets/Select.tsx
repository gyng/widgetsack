// One shared dropdown control for the whole studio, built on Downshift (headless → themed with the
// studio's own CSS, accessible WAI-ARIA combobox/listbox, keyboard nav). Two internal variants behind
// one <Select>:
//   • listbox (useSelect)   — a button + menu for small closed sets (align, kind, basis …).
//   • combobox (useCombobox) — a typeahead input + menu for long lists, and free-text where a value
//                              outside the list is valid (allowCustom, e.g. sensor ids).
// The menu is portaled to <body> and fixed-positioned under the trigger so a scrollable panel (the
// docked Inspector) can't clip it. Presentational: props in, value out — no store/Tauri access.
import {
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
	type CSSProperties,
	type RefObject
} from 'react';
import { createPortal } from 'react-dom';
import { useCombobox, useSelect } from 'downshift';
import { displayValue, filterOptions, optionFor, type SelectOption } from './selectOptions';
import ColorSwatch from './ColorSwatch';
import './Select.css';

export type { SelectOption };

type CommonProps = {
	value: string;
	options: SelectOption[];
	onChange: (value: string) => void;
	placeholder?: string;
	disabled?: boolean;
	className?: string;
	title?: string;
	/** Accessible name when the control isn't wrapped in a <label>. */
	'aria-label'?: string;
	/**
	 * The option that is in effect while `value` is '' (an unset config key falling back to its
	 * default). That option renders as selected and reads "<label> (default)" — in the trigger AND in
	 * the menu — while the value written on change stays the plain option value.
	 */
	defaultValue?: string;
};

type Props = CommonProps & {
	/** Show a typeahead filter input. Defaults on when the list is long or free-text is allowed. */
	searchable?: boolean;
	/** Accept a typed value that isn't one of the options (e.g. a sensor id). Implies searchable. */
	allowCustom?: boolean;
	/**
	 * Free-text (allowCustom) commit timing. 'input' (default) commits every keystroke; 'blur' holds
	 * the typed text and commits once on blur / Enter (or on picking an option) — so a hand-typed id
	 * is ONE change, not one per character.
	 */
	commitOn?: 'input' | 'blur';
	/** Select the whole text on focus (free-text), so a click-then-type replaces the id outright. */
	selectAllOnFocus?: boolean;
};

// Options with the `defaultValue` row relabelled "<label> (default)" (only while nothing is set).
function withDefaultLabel(
	options: SelectOption[],
	value: string,
	defaultValue: string | undefined
): SelectOption[] {
	if (value !== '' || !defaultValue) return options;
	return options.map((o) =>
		o.value === defaultValue ? { ...o, label: `${o.label} (default)` } : o
	);
}

const SEARCHABLE_THRESHOLD = 8;

// Track the trigger's viewport rect while open, so the body-portaled menu can be fixed-positioned
// under it. Capture-phase scroll listener catches scrolling in ANY ancestor (e.g. the docked rail).
function useAnchoredRect(ref: RefObject<HTMLElement | null>, open: boolean): DOMRect | null {
	const [rect, setRect] = useState<DOMRect | null>(null);
	useLayoutEffect(() => {
		if (!open) return;
		const update = () => {
			// An open Select necessarily has its wrapper ref attached.
			setRect(ref.current!.getBoundingClientRect());
		};
		update();
		window.addEventListener('scroll', update, true);
		window.addEventListener('resize', update);
		return () => {
			window.removeEventListener('scroll', update, true);
			window.removeEventListener('resize', update);
		};
	}, [open, ref]);
	return rect;
}

function menuStyle(rect: DOMRect | null): CSSProperties {
	if (!rect) return { display: 'none' };
	const below = window.innerHeight - rect.bottom;
	const flipUp = below < 200 && rect.top > below;
	return {
		position: 'fixed',
		left: rect.left,
		width: rect.width,
		...(flipUp ? { bottom: window.innerHeight - rect.top + 2 } : { top: rect.bottom + 2 })
	};
}

function SelectListbox({
	value: rawValue,
	options: rawOptions,
	onChange,
	placeholder,
	disabled,
	className,
	title,
	defaultValue,
	'aria-label': ariaLabel
}: CommonProps) {
	const wrapRef = useRef<HTMLDivElement | null>(null);
	// An unset value shows its effective default as the selection (labelled "(default)").
	const value = rawValue === '' && defaultValue ? defaultValue : rawValue;
	const options = useMemo(
		() => withDefaultLabel(rawOptions, rawValue, defaultValue),
		[rawOptions, rawValue, defaultValue]
	);
	const selectedItem = optionFor(options, value);
	const { isOpen, highlightedIndex, getToggleButtonProps, getMenuProps, getItemProps } =
		useSelect<SelectOption>({
			items: options,
			selectedItem,
			/* v8 ignore next -- Downshift invokes itemToString only for an item from options. */
			itemToString: (o) => o?.label ?? '',
			onSelectedItemChange: ({ selectedItem: sel }) => {
				/* v8 ignore next -- a selection-change callback always carries the chosen item. */
				if (sel) onChange(sel.value);
			}
		});
	const rect = useAnchoredRect(wrapRef, isOpen);

	return (
		<div className={['np-select', className].filter(Boolean).join(' ')} ref={wrapRef}>
			<button
				type="button"
				className="np-select-trigger"
				{...getToggleButtonProps({ disabled })}
				title={title}
				aria-label={ariaLabel}
			>
				{selectedItem?.swatch ? <ColorSwatch sw={selectedItem.swatch} /> : null}
				<span className={selectedItem ? 'np-select-value' : 'np-select-value np-select-ph'}>
					{selectedItem?.label ?? placeholder ?? ''}
				</span>
				<span className="np-select-caret" aria-hidden="true">
					▾
				</span>
			</button>
			{createPortal(
				<ul
					className="np-select-menu"
					style={isOpen ? menuStyle(rect) : { display: 'none' }}
					{...getMenuProps()}
				>
					{isOpen &&
						options.map((o, i) => (
							<li
								key={o.value}
								className="np-select-option"
								data-highlighted={highlightedIndex === i || undefined}
								data-selected={o.value === value || undefined}
								{...getItemProps({ item: o, index: i, disabled: o.disabled })}
							>
								{o.swatch ? <ColorSwatch sw={o.swatch} /> : null}
								<span className="np-select-opt-label">{o.label}</span>
								{o.hint ? <span className="np-select-opt-hint">{o.hint}</span> : null}
							</li>
						))}
				</ul>,
				document.body
			)}
		</div>
	);
}

function SelectCombobox({
	value,
	options,
	onChange,
	placeholder,
	disabled,
	className,
	title,
	allowCustom,
	commitOn = 'input',
	selectAllOnFocus,
	'aria-label': ariaLabel
}: CommonProps & Pick<Props, 'allowCustom' | 'commitOn' | 'selectAllOnFocus'>) {
	const wrapRef = useRef<HTMLDivElement | null>(null);
	const selectedItem = optionFor(options, value);
	const deferCommit = !!allowCustom && commitOn === 'blur';
	const [inputValue, setInputValue] = useState(() => displayValue(options, value, !!allowCustom));
	// Deferred commit only: true once the USER has typed (Downshift InputChange) and until that text is
	// committed, replaced by a pick, or cancelled with Escape. Downshift also rewrites inputValue on its
	// own (Escape on a closed menu empties it, blur-with-highlight fills it in) — none of that is typing,
	// and none of it may be committed as if it were: that path silently cleared a widget's sensor.
	const typedDirty = useRef(false);

	// Re-sync the visible text when `value` changes from OUTSIDE (reset / undo / programmatic), but not
	// on every render — that would clobber typing. lastValue tracks the value we last reflected.
	const lastValue = useRef(value);
	useEffect(() => {
		if (value !== lastValue.current) {
			lastValue.current = value;
			typedDirty.current = false;
			setInputValue(displayValue(options, value, !!allowCustom));
		}
		// oxlint-disable-next-line react-hooks/exhaustive-deps -- only an external value change resets text
	}, [value, allowCustom]);

	// Filter once the user is typing; show the FULL list when the text still matches the selection (so
	// opening doesn't collapse to a single row). For free-text, an exact-id match also shows the full list.
	const exact = !!optionFor(options, inputValue);
	const query = allowCustom
		? exact
			? ''
			: inputValue
		: inputValue === displayValue(options, value, false)
			? ''
			: inputValue;
	const items = useMemo(() => filterOptions(options, query), [options, query]);

	const {
		isOpen,
		highlightedIndex,
		getMenuProps,
		getInputProps,
		getToggleButtonProps,
		getItemProps,
		openMenu
	} = useCombobox<SelectOption>({
		items,
		inputValue,
		// In free-text mode the value changes on every keystroke, so a CONTROLLED selectedItem would flip
		// to null (no exact match) and Downshift would reset the input to itemToString(null)='' — clearing
		// each character. Leave selection uncontrolled there; the menu highlight is computed manually below.
		selectedItem: allowCustom ? null : selectedItem,
		itemToString: (o) => (o ? (allowCustom ? o.value : o.label) : ''),
		onInputValueChange: ({ inputValue: iv, type }) => {
			/* v8 ignore next -- Downshift supplies a string for input-change notifications. */
			const next = iv ?? '';
			setInputValue(next);
			if (type !== useCombobox.stateChangeTypes.InputChange) return;
			typedDirty.current = true;
			// Free-text commits live (mirrors the old onInput sensor field); closed selects commit on pick.
			// NB: do NOT touch lastValue here — `value` updates a render later (the commit is async), and
			// pre-empting it makes the sync effect below "correct" the input back to the stale value,
			// clearing each keystroke. The effect alone reconciles lastValue once `value` actually changes.
			if (allowCustom && !deferCommit) onChange(next.trim());
		},
		onSelectedItemChange: ({ selectedItem: sel }) => {
			if (!sel) return;
			typedDirty.current = false;
			onChange(sel.value);
			setInputValue(allowCustom ? sel.value : sel.label);
		},
		// Deferred commit: Escape CANCELS the edit — the text snaps back to the current value. Left to
		// Downshift, a second Escape (menu already closed) empties the input, and the blur that follows
		// would have committed '' (a widget losing its sensor binding by pressing Escape twice).
		stateReducer: (_state, { type, changes }) =>
			deferCommit && type === useCombobox.stateChangeTypes.InputKeyDownEscape
				? { ...changes, inputValue: displayValue(options, value, true) }
				: changes
	});
	const rect = useAnchoredRect(wrapRef, isOpen);

	// Deferred free-text commit (wired only when deferCommit): the typed text becomes the value on
	// blur / Enter (one change). Nothing is committed unless the user actually typed (typedDirty), the
	// text differs from the current value, and Downshift isn't about to pick a highlighted row itself
	// (blur with an open menu + highlight selects that row via onSelectedItemChange — committing the
	// half-typed text first would write an invalid id AND cost a second undo step).
	const commitTyped = (): void => {
		if (isOpen && highlightedIndex >= 0) return;
		if (!typedDirty.current) return;
		typedDirty.current = false;
		const next = inputValue.trim();
		if (next !== value) onChange(next);
	};

	// On close, a non-custom combobox with stray filter text snaps back to the selected label. Runs on
	// the open→close transition only (store-previous idiom), during render rather than in an effect.
	const [prevOpen, setPrevOpen] = useState(isOpen);
	if (isOpen !== prevOpen) {
		setPrevOpen(isOpen);
		if (!isOpen && !allowCustom) {
			const d = displayValue(options, value, false);
			if (inputValue !== d) setInputValue(d);
		}
	}

	return (
		<div
			className={['np-select', 'np-select-combo', className].filter(Boolean).join(' ')}
			ref={wrapRef}
		>
			<div className="np-select-trigger">
				{selectedItem?.swatch ? <ColorSwatch sw={selectedItem.swatch} /> : null}
				<input
					className="np-select-input"
					placeholder={placeholder}
					title={title}
					// onBlur goes THROUGH the prop getter so Downshift chains it before its own blur handling
					// (close the menu / pick the highlighted row). Set after the spread it would replace that
					// handler outright — even as `undefined` — leaving the menu open on focus-out.
					{...getInputProps({
						disabled,
						'aria-label': ariaLabel,
						onBlur: deferCommit ? commitTyped : undefined
					})}
					// Open the list on a plain click of the field (not just the ▾ caret) — clicking a combobox
					// to see its options is what users expect ("I can't click to choose"). Attached after the
					// prop-getter spread so it isn't dropped; useCombobox sets no onClick of its own to compose.
					onClick={() => openMenu()}
					onFocus={selectAllOnFocus ? (e) => e.currentTarget.select() : undefined}
					onKeyDownCapture={
						deferCommit
							? (e) => {
									// Enter commits the typed text — unless an option is highlighted in the open
									// menu, in which case Downshift picks it and onSelectedItemChange commits that.
									// Escape cancels: the stateReducer above restores the text, so drop the edit.
									if (e.key === 'Enter') commitTyped();
									else if (e.key === 'Escape') typedDirty.current = false;
								}
							: undefined
					}
				/>
				<button
					type="button"
					className="np-select-caret"
					aria-label="Toggle options"
					{...getToggleButtonProps({ disabled })}
				>
					▾
				</button>
			</div>
			{createPortal(
				<ul
					className="np-select-menu"
					style={isOpen ? menuStyle(rect) : { display: 'none' }}
					{...getMenuProps()}
				>
					{isOpen &&
						items.map((o, i) => (
							<li
								key={o.value}
								className="np-select-option"
								data-highlighted={highlightedIndex === i || undefined}
								data-selected={o.value === value || undefined}
								{...getItemProps({ item: o, index: i, disabled: o.disabled })}
							>
								{o.swatch ? <ColorSwatch sw={o.swatch} /> : null}
								<span className="np-select-opt-label">{o.label}</span>
								{o.hint ? <span className="np-select-opt-hint">{o.hint}</span> : null}
							</li>
						))}
					{isOpen && items.length === 0 ? (
						<li className="np-select-empty" aria-disabled="true">
							no matches
						</li>
					) : null}
				</ul>,
				document.body
			)}
		</div>
	);
}

export default function Select(props: Props) {
	const { searchable, allowCustom, options } = props;
	const combo = allowCustom || (searchable ?? options.length > SEARCHABLE_THRESHOLD);
	return combo ? <SelectCombobox {...props} /> : <SelectListbox {...props} />;
}
