import type { Group, Library } from '../core/layoutTree';
import { groupChartState, setGroupChartsSmooth } from '../core/groupCharts';

type Props = { group: Group; library: Library; onChange: (group: Group) => void };
export default function GroupChartOptions({ group, library, onChange }: Props) {
	const state = groupChartState(group, library);
	if (!state.count) return null;
	return (
		<div className="cfg-field cfg-toggle">
			<label className="check">
				<input
					type="checkbox"
					aria-label="Smooth charts"
					aria-checked={state.value === 'mixed' ? 'mixed' : state.value === 'on'}
					checked={state.value === 'on'}
					ref={(input) => {
						if (input) input.indeterminate = state.value === 'mixed';
					}}
					onChange={(event) =>
						onChange(setGroupChartsSmooth(group, event.currentTarget.checked, library))
					}
				/>
				<span>Smooth charts</span>
			</label>
			<span className="field-help">
				Blend changes on all charts in this widget. Recorded values stay unchanged.
			</span>
			{state.value === 'mixed' && (
				<span className="field-help">
					Some charts use smoothing. Select this option to smooth all charts.
				</span>
			)}
			{group.def && (
				<span className="field-help">
					This creates a separate copy. Other instances of this custom widget stay unchanged.
				</span>
			)}
		</div>
	);
}
