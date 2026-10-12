import { useEffect, useState } from 'react';
import { decodeTasks, type Task } from '../core/dashboard';
import Checklist from './meters/Checklist';
const read = (key: string, legacyKey: string): Task[] => {
	try {
		return decodeTasks(
			localStorage.getItem(key) ?? (key !== legacyKey ? localStorage.getItem(legacyKey) : null)
		);
	} catch {
		return [];
	}
};
export default function ChecklistHost({
	widgetId = '',
	widgetInstanceId = widgetId,
	label = 'Today',
	editMode = false,
	previewMode = false
}: {
	widgetId?: string;
	widgetInstanceId?: string;
	label?: string;
	editMode?: boolean;
	previewMode?: boolean;
}) {
	const key = `checklist:${widgetInstanceId}`;
	const legacyKey = `checklist:${widgetId}`;
	const [tasks, setTasks] = useState(() => read(key, legacyKey));
	const [draft, setDraft] = useState('');
	const [error, setError] = useState('');
	const [prevKey, setPrevKey] = useState(key);
	if (key !== prevKey) {
		setPrevKey(key);
		setTasks(read(key, legacyKey));
		setDraft('');
		setError('');
	}
	useEffect(() => {
		const sync = (e: StorageEvent) => {
			if (e.key === key || e.key === null) setTasks(read(key, legacyKey));
		};
		window.addEventListener('storage', sync);
		return () => window.removeEventListener('storage', sync);
	}, [key, legacyKey]);
	const save = (next: Task[]) => {
		setTasks(next);
		try {
			localStorage.setItem(key, JSON.stringify(next));
			setError('');
		} catch {
			setError('Tasks could not be saved.');
		}
	};
	return (
		<Checklist
			tasks={tasks}
			draft={draft}
			label={label}
			editMode={editMode || previewMode}
			error={error}
			onDraft={setDraft}
			onAdd={() => {
				if (!draft.trim() || editMode || previewMode) return;
				save([...tasks, { id: crypto.randomUUID(), text: draft.trim(), done: false }]);
				setDraft('');
			}}
			onToggle={(id) => save(tasks.map((t) => (t.id === id ? { ...t, done: !t.done } : t)))}
			onRemove={(id) => save(tasks.filter((t) => t.id !== id))}
		/>
	);
}
