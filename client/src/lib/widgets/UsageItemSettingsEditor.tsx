import type { UsageItem } from '../core/aiUsage';
import type { UsageSettings } from '../core/aiUsageSettings';
export default function UsageItemSettingsEditor({
	item,
	value,
	onChange
}: {
	item: UsageItem | 'eta';
	value: UsageSettings;
	onChange: (value: Partial<UsageSettings>) => void;
}) {
	if (item === 'graph')
		return (
			<>
				<label>
					Graph metric
					<select
						value={value.graphMetric}
						onChange={(e) =>
							onChange({ graphMetric: e.target.value as UsageSettings['graphMetric'] })
						}
					>
						{['tokens', 'credits', 'quota'].map((key) => (
							<option key={key}>{key}</option>
						))}
					</select>
				</label>
				<label>
					History hours
					<input
						type="number"
						min={1}
						max={720}
						value={value.graphHours}
						onChange={(e) => onChange({ graphHours: Number(e.target.value) })}
					/>
				</label>
			</>
		);
	if (item === 'eta')
		return (
			<label>
				Rate window hours
				<input
					type="number"
					min={0.25}
					max={24}
					step={0.25}
					value={value.rateHours}
					onChange={(e) => onChange({ rateHours: Number(e.target.value) })}
				/>
			</label>
		);
	if (item === 'resets')
		return (
			<label>
				Reset format
				<select
					value={value.resetDisplay}
					onChange={(e) =>
						onChange({ resetDisplay: e.target.value as UsageSettings['resetDisplay'] })
					}
				>
					{['countdown', 'date', 'both'].map((key) => (
						<option key={key}>{key}</option>
					))}
				</select>
			</label>
		);

	return (
		<>
			<label>
				Display
				<select
					value={value.remaining ? 'left' : 'used'}
					onChange={(e) => onChange({ remaining: e.target.value === 'left' })}
				>
					<option value="left">Left</option>
					<option value="used">Used</option>
				</select>
			</label>

			{['session', 'week', 'other'].includes(item) && (
				<>
					<label>
						<input
							type="checkbox"
							checked={value.showMode}
							onChange={(e) => onChange({ showMode: e.target.checked })}
						/>
						Show left / used suffix
					</label>
					<label>
						Warning used %
						<input
							type="number"
							min={0}
							max={100}
							value={value.warning}
							onChange={(e) => onChange({ warning: Number(e.target.value) })}
						/>
					</label>
					<label>
						Critical used %
						<input
							type="number"
							min={0}
							max={100}
							value={value.critical}
							onChange={(e) => onChange({ critical: Number(e.target.value) })}
						/>
					</label>
				</>
			)}
		</>
	);
}
