import Icon from './Icon';
// Atom: isolates one widget's render/runtime crash so a single bad widget — a buggy meter, a
// malformed config, a sensor value its render can't handle — degrades to a small inline fallback
// instead of unmounting the whole overlay's React tree (one throw would otherwise blank every
// widget on the monitor). React error boundaries must be class components; this is the only one
// in the app, and exists solely for that reason.
//
// Reset policy: a caught error is cleared when `resetKey` changes. WidgetHost derives that key from
// the widget's TYPE + CONFIG — the user-editable definition — so fixing a broken widget in the
// studio re-renders it live. It deliberately does NOT key on the live sensor value: that would
// re-throw (and re-log) on every telemetry tick for a persistently-broken widget — React logs each
// caught error to console.error itself, noise we can't suppress. A value-driven crash therefore
// stays on the fallback until the definition changes: a stable, quiet failure over a flickering one.
import { Component, type ErrorInfo, type ReactNode } from 'react';

type Props = {
	/** When this value changes, a previously-caught error is cleared and children re-render. */
	resetKey?: unknown;
	/** Shown in the fallback + the console warning (the widget type). */
	label?: string;
	children: ReactNode;
};
type State = { error: Error | null };

export default class WidgetErrorBoundary extends Component<Props, State> {
	state: State = { error: null };
	// Dedupe console noise: warn once per distinct message. React still logs the raw error per catch.
	private lastLogged = '';

	static getDerivedStateFromError(error: Error): State {
		return { error };
	}

	componentDidCatch(error: Error, info: ErrorInfo): void {
		const msg = error?.message ?? String(error);
		if (msg === this.lastLogged) return;
		this.lastLogged = msg;
		console.warn(
			`widget "${this.props.label ?? '?'}" crashed; showing fallback`,
			error,
			info.componentStack
		);
	}

	componentDidUpdate(prev: Props, prevState: State): void {
		// Recovered cleanly → let a future identical error log again.
		if (prevState.error && !this.state.error) this.lastLogged = '';
		// resetKey changed while erroring → retry by clearing the error (children re-render).
		if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null });
	}

	render(): ReactNode {
		const { error } = this.state;
		if (error) {
			return (
				<div className="widget-error" title={error.message}>
					<Icon name="alert" /> {this.props.label ?? 'widget'}
				</div>
			);
		}
		return this.props.children;
	}
}
