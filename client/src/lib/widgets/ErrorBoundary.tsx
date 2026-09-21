// A small error boundary (class component — React has no hook equivalent) so one throwing
// subtree (a studio rail section, the stage, a plugin's settings panel) degrades to a compact
// inline fallback instead of unmounting the whole studio. The fallback offers a way back —
// "Reload section" remounts the children (clears the caught error) and "Copy error" puts the
// message + stack on the clipboard for a bug report — so a crashed section is never a dead end.
// A caught error also clears when `resetKey` changes (e.g. the selected node / monitor), and the
// caller can still key the boundary by the wrapped content's identity to remount it wholesale.

import { Component, type ErrorInfo, type ReactNode } from 'react';
import './ErrorBoundary.css';

type Props = {
	label?: string;
	/** When this value changes, a previously-caught error is cleared and children re-render. */
	resetKey?: unknown;
	/** Copy helper (the container supplies the clipboard adapter). Defaults to navigator.clipboard. */
	onCopy?: (text: string) => void | Promise<unknown>;
	children: ReactNode;
};
type State = { error: string | null; stack: string };

export default class ErrorBoundary extends Component<Props, State> {
	state: State = { error: null, stack: '' };

	static getDerivedStateFromError(err: unknown): State {
		return {
			error: err instanceof Error ? err.message : String(err),
			stack: err instanceof Error ? (err.stack ?? '') : ''
		};
	}

	componentDidCatch(err: unknown, info: ErrorInfo): void {
		console.error(`${this.props.label ?? 'panel'} crashed`, err);
		this.setState({ stack: [this.state.stack, info.componentStack].filter(Boolean).join('\n') });
	}

	componentDidUpdate(prev: Props): void {
		// resetKey changed while erroring → retry by clearing the error (children re-render).
		if (this.state.error !== null && prev.resetKey !== this.props.resetKey) this.reset();
	}

	private reset = (): void => this.setState({ error: null, stack: '' });

	private copy = (): void => {
		const text = `${this.props.label ?? 'panel'} failed: ${this.state.error}\n${this.state.stack}`;
		const copy = this.props.onCopy ?? ((t: string) => navigator.clipboard?.writeText(t));
		void copy(text);
	};

	render(): ReactNode {
		if (this.state.error !== null) {
			const label = this.props.label ?? 'This panel';
			return (
				<div className="error-boundary" role="alert">
					<span className="eb-msg">
						⚠ {label} failed to render: {this.state.error}
					</span>
					<span className="eb-actions">
						<button type="button" onClick={this.reset} title="Remount this section and try again">
							Reload section
						</button>
						<button
							type="button"
							onClick={this.copy}
							title="Copy the error message + stack for a bug report"
						>
							Copy error
						</button>
					</span>
				</div>
			);
		}
		return this.props.children;
	}
}
