import { useEffect, useRef } from 'react';
import { isCustomHtmlReady, type CustomHtmlState } from '../../core/customHtml';
import './CustomHtml.css';

export type CustomHtmlProps = {
	url?: string;
	srcDoc?: string;
	token: string;
	title: string;
	interact: boolean;
	state: CustomHtmlState;
};

export default function CustomHtml({
	url,
	srcDoc,
	token,
	title,
	interact,
	state
}: CustomHtmlProps) {
	const frame = useRef<HTMLIFrameElement>(null);
	useEffect(() => {
		const send = () =>
			frame.current?.contentWindow?.postMessage(
				{ type: 'widgetsack:state', version: 1, token, state },
				'*'
			);
		const ready = (event: MessageEvent) => {
			if (event.source === frame.current?.contentWindow && isCustomHtmlReady(event.data, token))
				send();
		};
		window.addEventListener('message', ready);
		send();
		return () => window.removeEventListener('message', ready);
	}, [state, token]);
	return (
		<div className="np-customhtml" data-part="root">
			<iframe
				ref={frame}
				src={url}
				srcDoc={srcDoc}
				title={title}
				sandbox="allow-scripts"
				referrerPolicy="no-referrer"
				data-part="frame"
				style={{ pointerEvents: interact ? 'auto' : 'none' }}
				{...(interact ? { 'data-interactive': true } : {})}
			/>
			{!interact && <span className="customhtml-sentinel" data-interactive aria-hidden="true" />}
		</div>
	);
}
