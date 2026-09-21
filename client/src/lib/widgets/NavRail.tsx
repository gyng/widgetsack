// The studio's left nav strip (presentational molecule): a permanent vertical column of section
// buttons carved from the left rail. Props-only — the active section + selection are owned by the
// Canvas. The matching panel (Outline / designer / sensors / …) renders beside it. The one
// self-sourced bit is the Settings item's update badge: it mirrors the backend's background
// update check (lib/appUpdate.ts store) so a newer release is visible from any section.
import { SECTIONS, type Section, type SectionId } from './canvas/studioSections';
import { useAppUpdate } from '../appUpdate';
import { updateBadge } from '../core/updateNotice';
import './NavRail.css';

// A short label of this many characters or more doesn't fit the strip at --text-xs monospace.
const LONG_SHORT_LABEL = 8;

type Props = {
	active: SectionId;
	onSelect: (id: SectionId) => void;
};

export default function NavRail({ active, onSelect }: Props) {
	const badge = updateBadge(useAppUpdate());
	const item = (s: Section) => (
		<button
			key={s.id}
			type="button"
			data-section={s.id}
			className={['nav-item', s.id === active && 'active'].filter(Boolean).join(' ')}
			// Native tooltip only when it ADDS to the visible short label (an abbreviation like "Custom" →
			// "Widget designer", a section's own `title` like "Sacks — export/import") or flags a stub —
			// otherwise it just repeats the label that's already shown, which reads as redundant clutter.
			// The full name is the accessible name regardless, via aria-label.
			title={
				s.title ??
				(s.label !== s.short || s.stub ? s.label + (s.stub ? ' (coming soon)' : '') : undefined)
			}
			aria-label={s.label + (s.stub ? ' (coming soon)' : '')}
			// Convey the open section to assistive tech (the visual cue is colour-only otherwise — WCAG
			// 1.4.1). aria-current marks the active rail item as the current "page" of the studio.
			aria-current={s.id === active ? 'page' : undefined}
			onClick={() => onSelect(s.id)}
		>
			{/* Decorative glyph: the aria-label already names the button, so hide the icon from screen
			    readers to avoid a doubled / emoji-name announcement. */}
			<span className="nav-icon" aria-hidden="true">
				{s.icon}
			</span>
			{/* Long labels ("BACKGROUND", "SHORTCUTS") drop to the compact size so they never overflow the
			    56px strip; the class flips at 8 chars (the widest that fits at the normal size). */}
			<span
				className={s.short.length >= LONG_SHORT_LABEL ? 'nav-short nav-short--long' : 'nav-short'}
			>
				{s.short}
			</span>
			{s.id === 'settings' && badge && (
				<span
					className="nav-badge"
					title={`Update available: ${badge} — see Settings → About`}
					style={{
						fontSize: '0.7em',
						lineHeight: 1,
						padding: '2px 5px',
						borderRadius: 999,
						background: 'rgb(var(--ui-accent-rgb))',
						color: 'var(--ui-bg)',
						whiteSpace: 'nowrap'
					}}
				>
					{badge}
				</span>
			)}
		</button>
	);
	return (
		<nav className="nav-rail" aria-label="Studio sections">
			{SECTIONS.filter((s) => s.group === 'main').map(item)}
			<div className="nav-spacer" />
			{SECTIONS.filter((s) => s.group === 'foot').map(item)}
		</nav>
	);
}
