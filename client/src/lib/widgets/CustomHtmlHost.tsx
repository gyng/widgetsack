import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { buildCustomHtmlDocument, type CustomHtmlState } from '../core/customHtml';
import { DEFAULT_TOKENS, TOKEN_NAMES } from '../core/tokens';
import type { SensorStateMap } from './useSensorMap';
import CustomHtml from './meters/CustomHtml';
import { registerCustomHtml, releaseCustomHtml } from './plugins/customhtml-commands';

type Props = {
	html?: string;
	css?: string;
	javascript?: string;
	sensors?: SensorStateMap;
	title?: string;
	interact?: boolean;
};
const EMPTY_SENSORS: SensorStateMap = {};

/** Source replacement owns a fresh session, so cached native URLs and late registrations cannot win. */
export default function CustomHtmlHost(props: Props) {
	return (
		<CustomHtmlSession key={JSON.stringify([props.html, props.css, props.javascript])} {...props} />
	);
}

function CustomHtmlSession({
	html = '',
	css = '',
	javascript = '',
	sensors = EMPTY_SENSORS,
	title = 'Custom HTML widget',
	interact = false
}: Props) {
	const [token] = useState(() => crypto.randomUUID());
	const document = useMemo(
		() => buildCustomHtmlDocument(html, css, javascript, token),
		[html, css, javascript, token]
	);
	const [source, setSource] = useState<{ url?: string; srcDoc?: string } | null>(null);
	const [error, setError] = useState('');
	const host = useRef<HTMLDivElement>(null);
	const [environment, setEnvironment] = useState<Omit<CustomHtmlState, 'sensors'>>({
		tokens: DEFAULT_TOKENS,
		size: { width: 0, height: 0, pixelRatio: 1 }
	});
	useEffect(() => {
		let disposed = false;
		void registerCustomHtml(token, document).then(
			(value) => {
				if (disposed) {
					void releaseCustomHtml(token);
					return;
				}
				setSource(value);
			},
			() => {
				if (!disposed) setError('Custom HTML unavailable');
			}
		);
		return () => {
			disposed = true;
			void releaseCustomHtml(token);
		};
	}, [token, document]);
	useLayoutEffect(() => {
		const element = host.current!;
		const update = () => {
			const computed = getComputedStyle(element);
			const next = {
				tokens: Object.fromEntries(
					TOKEN_NAMES.map((name) => [
						name,
						computed.getPropertyValue(name).trim() || DEFAULT_TOKENS[name]
					])
				),
				size: {
					width: element.clientWidth,
					height: element.clientHeight,
					pixelRatio: window.devicePixelRatio
				}
			};
			setEnvironment((previous) =>
				JSON.stringify(previous) === JSON.stringify(next) ? previous : next
			);
		};
		update();
		const resize = new ResizeObserver(update);
		resize.observe(element);
		const mutation = new MutationObserver(update);
		let ancestor: HTMLElement | null = element;
		while (ancestor) {
			mutation.observe(ancestor, { attributes: true, attributeFilter: ['style', 'class'] });
			ancestor = ancestor.parentElement;
		}
		mutation.observe(window.document.head, { childList: true, subtree: true, characterData: true });
		window.addEventListener('resize', update);
		return () => {
			resize.disconnect();
			mutation.disconnect();
			window.removeEventListener('resize', update);
		};
	}, []);
	const state = useMemo(() => ({ ...environment, sensors }), [environment, sensors]);
	return (
		<div ref={host} className="np-customhtml-host" style={{ width: '100%', height: '100%' }}>
			{source ? (
				<CustomHtml {...source} token={token} state={state} title={title} interact={interact} />
			) : (
				<span className="np-customhtml-status" role="status">
					{error || 'Loading custom HTML…'}
				</span>
			)}
		</div>
	);
}
