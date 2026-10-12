import type { Task } from '../../core/dashboard';
import './Dashboard.css';
export default function Checklist({
	tasks,
	draft,
	label,
	editMode,
	error,
	onDraft,
	onAdd,
	onToggle,
	onRemove
}: {
	tasks: Task[];
	draft: string;
	label: string;
	editMode: boolean;
	error: string;
	onDraft: (s: string) => void;
	onAdd: () => void;
	onToggle: (id: string) => void;
	onRemove: (id: string) => void;
}) {
	return (
		<section className="np-dashboard" aria-label={label}>
			<header>
				{label} · {tasks.filter((t) => t.done).length}/{tasks.length}
			</header>
			{tasks.map((t) => (
				<div className="dashboard-row" data-done={t.done} key={t.id}>
					<input
						type="checkbox"
						checked={t.done}
						disabled={editMode}
						aria-label={t.text}
						onChange={() => onToggle(t.id)}
					/>
					<span>{t.text}</span>
					<button
						disabled={editMode}
						aria-label={`Remove ${t.text}`}
						onClick={() => onRemove(t.id)}
					>
						×
					</button>
				</div>
			))}
			<form
				className="dashboard-row"
				onSubmit={(e) => {
					e.preventDefault();
					onAdd();
				}}
			>
				<input
					type="text"
					value={draft}
					disabled={editMode}
					placeholder="Add a task…"
					aria-label="New task"
					onChange={(e) => onDraft(e.target.value)}
				/>
				<button disabled={editMode || !draft.trim()} type="submit">
					Add
				</button>
			</form>
			{error && <span role="alert">{error}</span>}
		</section>
	);
}
