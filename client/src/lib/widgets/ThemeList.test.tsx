import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import ThemeList, { filterThemes, type ThemeGroup } from './ThemeList';

describe('filterThemes', () => {
	const themes = ['amber', 'mono', 'midnight-blue'];

	it('returns all for an empty/whitespace query', () => {
		expect(filterThemes(themes, '')).toEqual(themes);
		expect(filterThemes(themes, '  ')).toEqual(themes);
	});

	it('matches a case-insensitive substring', () => {
		expect(filterThemes(themes, 'm')).toEqual(['amber', 'mono', 'midnight-blue']); // all contain 'm'
		expect(filterThemes(themes, 'mo')).toEqual(['mono']);
		expect(filterThemes(themes, 'AMBER')).toEqual(['amber']);
		expect(filterThemes(themes, 'blue')).toEqual(['midnight-blue']);
	});

	it('returns [] when nothing matches', () => {
		expect(filterThemes(themes, 'zzz')).toEqual([]);
	});
});

describe('<ThemeList>', () => {
	const groups: ThemeGroup[] = [
		{
			key: 'classic',
			label: 'Classic',
			items: [
				{
					value: 'builtin:app',
					label: 'App',
					swatch: { bg: '#0b0b0e', accent: '#77c4d3', fg: '#fff' }
				}
			]
		},
		{ key: 'dark', label: 'Dark', items: [{ value: 'builtin:nord', label: 'Nord' }] }
	];

	const setup = (active = '') => {
		const onPick = vi.fn();
		const onEdit = vi.fn();
		const onDuplicate = vi.fn();
		const onDelete = vi.fn();
		render(
			<ThemeList
				groups={groups}
				userThemes={[{ value: 'my-theme', label: 'my-theme' }]}
				active={active}
				onPick={onPick}
				onEdit={onEdit}
				onDuplicate={onDuplicate}
				onDelete={onDelete}
			/>
		);
		return { onPick, onEdit, onDuplicate, onDelete };
	};

	it('renders the default reset, the built-in groups, and the user section', () => {
		setup();
		expect(screen.getByText('(default)')).toBeInTheDocument();
		expect(screen.getByText('Classic')).toBeInTheDocument();
		expect(screen.getByText('Dark')).toBeInTheDocument();
		expect(screen.getByText('Your themes')).toBeInTheDocument();
		expect(screen.getByText('App')).toBeInTheDocument();
		expect(screen.getByText('Nord')).toBeInTheDocument();
		expect(screen.getByText('my-theme')).toBeInTheDocument();
	});

	it('renders a colour swatch on a row that has one, filled with the theme surface', () => {
		setup();
		const appRow = screen.getByText('App').closest('.theme-item') as HTMLElement;
		const sw = appRow.querySelector('.np-swatch') as HTMLElement;
		expect(sw).not.toBeNull();
		expect(sw.style.background).toContain('#0b0b0e'); // the theme surface fills the swatch
		expect(sw.querySelectorAll('.np-swatch-dot')).toHaveLength(2); // accent + fg dots
		// A row whose swatch hasn't been parsed yet (user theme still loading) shows the neutral chip.
		const userRow = screen.getByText('my-theme').closest('.theme-item') as HTMLElement;
		expect(userRow.querySelector('.np-swatch-empty')).not.toBeNull();
	});

	it('picks a built-in by its namespaced value', () => {
		const { onPick } = setup();
		fireEvent.click(screen.getByRole('button', { name: /^Nord/ }));
		expect(onPick).toHaveBeenCalledWith('builtin:nord');
	});

	it('picks the default reset with the empty value', () => {
		const { onPick } = setup('builtin:nord');
		fireEvent.click(screen.getByRole('button', { name: /\(default\)/ }));
		expect(onPick).toHaveBeenCalledWith('');
	});

	it('offers only duplicate (no edit / delete) for an immutable built-in', () => {
		const { onDuplicate, onEdit, onDelete } = setup();
		const nordRow = screen.getByText('Nord').closest('.theme-item') as HTMLElement;
		expect(within(nordRow).queryByLabelText(/^Edit/)).toBeNull();
		expect(within(nordRow).queryByLabelText(/^Delete/)).toBeNull();
		fireEvent.click(within(nordRow).getByLabelText('Duplicate Nord'));
		expect(onDuplicate).toHaveBeenCalledWith('builtin:nord');
		expect(onEdit).not.toHaveBeenCalled();
		expect(onDelete).not.toHaveBeenCalled();
	});

	it('offers edit / duplicate / delete for a user theme, keyed by its name', () => {
		const { onEdit, onDuplicate, onDelete } = setup();
		const row = screen.getByText('my-theme').closest('.theme-item') as HTMLElement;
		fireEvent.click(within(row).getByLabelText('Edit my-theme CSS'));
		fireEvent.click(within(row).getByLabelText('Duplicate my-theme'));
		fireEvent.click(within(row).getByLabelText('Delete my-theme'));
		expect(onEdit).toHaveBeenCalledWith('my-theme');
		expect(onDuplicate).toHaveBeenCalledWith('my-theme');
		expect(onDelete).toHaveBeenCalledWith('my-theme');
	});

	it('marks the active row', () => {
		setup('builtin:nord');
		const nordRow = screen.getByRole('button', { name: /^Nord/ });
		expect(nordRow).toHaveAttribute('aria-pressed', 'true');
	});

	// The filter box only appears once the combined list is long enough to be worth searching
	// (FILTER_THRESHOLD = 8 non-default items).
	describe('filter box (long list)', () => {
		// 10 user themes → comfortably over the threshold and easy to filter down deterministically.
		const manyUser = Array.from({ length: 10 }, (_, i) => ({
			value: `theme-${i}`,
			label: i < 3 ? `alpha-${i}` : `beta-${i}`
		}));

		const renderMany = () =>
			render(
				<ThemeList
					groups={[]}
					userThemes={manyUser}
					active=""
					onPick={vi.fn()}
					onEdit={vi.fn()}
					onDuplicate={vi.fn()}
					onDelete={vi.fn()}
				/>
			);

		it('does NOT show the filter box for a short list', () => {
			setup(); // 2 built-ins + 1 user = 3 non-default, below the threshold
			expect(screen.queryByLabelText('Filter themes')).toBeNull();
		});

		it('shows the filter box and the total count once the list is long', () => {
			renderMany();
			expect(screen.getByLabelText('Filter themes')).toBeInTheDocument();
			// total = 10 user + 1 default = 11; with no query shown === total so the bare total renders.
			expect(screen.getByText('11')).toBeInTheDocument();
		});

		it('filters the visible rows and shows a "shown / total" count as you type', () => {
			renderMany();
			const input = screen.getByLabelText('Filter themes') as HTMLInputElement;
			fireEvent.input(input, { target: { value: 'alpha' } });
			// Only the 3 alpha-* user themes survive; the default no longer matches.
			expect(screen.getByText('alpha-0')).toBeInTheDocument();
			expect(screen.queryByText('beta-3')).toBeNull();
			expect(screen.queryByText('(default)')).toBeNull();
			expect(screen.getByText('3 / 11')).toBeInTheDocument();
		});

		it('keeps the "(default)" reset visible when the query matches it', () => {
			renderMany();
			const input = screen.getByLabelText('Filter themes') as HTMLInputElement;
			fireEvent.input(input, { target: { value: 'default' } });
			expect(screen.getByText('(default)')).toBeInTheDocument();
			expect(screen.getByText('1 / 11')).toBeInTheDocument();
		});

		it('shows the empty stub when nothing matches the query', () => {
			renderMany();
			const input = screen.getByLabelText('Filter themes') as HTMLInputElement;
			fireEvent.input(input, { target: { value: 'zzz-no-such-theme' } });
			expect(screen.getByText('No themes match.')).toBeInTheDocument();
			expect(screen.getByText('0 / 11')).toBeInTheDocument();
		});
	});
});
