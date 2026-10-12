import { DASHBOARD_SACKS } from '../src/lib/core/dashboardSacks';
import { container, type WidgetInstance } from '../src/lib/core/layoutTree';
import { assembleStyles, scopeCss } from '../src/lib/core/style';
import { tokensToCss } from '../src/lib/core/tokens';
import FlowNode, { type RenderLeaf } from '../src/lib/widgets/FlowNode';
import StyleLayer from '../src/lib/widgets/StyleLayer';
import WidgetHost from '../src/lib/widgets/WidgetHost';
import { TelemetryHubContext } from '../src/lib/widgets/telemetryContext';
import { FROZEN, makeHub } from './seed';

const hub = makeHub();
// Illustrative alert data, isolated from the individual-widget gallery.
hub.ingest({
	sensor: 'disk.c.used.pct',
	ts_ms: FROZEN.getTime(),
	value: { kind: 'scalar', value: 92 }
});

export default function PresetGallery() {
	return (
		<TelemetryHubContext.Provider value={hub}>
			<h2>Dashboard presets</h2>
			<div className="preset-grid">
				{Object.values(DASHBOARD_SACKS).map((sack) => {
					const def = sack.library!.defs[0];
					const selector = `[data-def="${def.id}"]`;
					const child = def.child;
					const scale = Math.min(392 / def.size.w, 636 / def.size.h, 1);
					const css = [
						tokensToCss(sack.tokens ?? {}, selector),
						scopeCss(def.css, selector),
						assembleStyles({
							monitor: { root: container('preset-styles', 'col', [child]), floating: [] }
						})
							.replaceAll('[data-w="', '[data-w="preset/')
							.replaceAll('[data-id="', '[data-id="preset/')
					].join('\n');
					const renderLeaf: RenderLeaf = (leaf, id) => {
						const instance = leaf.unit as WidgetInstance;
						// The Home preset intentionally ships without an endpoint. Show a configured example.
						const shown =
							instance.type === 'servicehealth'
								? {
										...instance,
										config: { ...instance.config, url: 'https://home.example/health' }
									}
								: instance;
						return <WidgetHost flow hub={hub} instance={shown} domId={id} />;
					};
					return (
						<figure className="cell" key={def.id}>
							<StyleLayer css={css} />
							<div
								className="preset-stage"
								data-shot={`preset-${sack.name!.toLowerCase().replaceAll(' ', '-')}`}
							>
								<div className="preset-frame">
									<div
										style={{
											width: def.size.w * scale,
											height: def.size.h * scale,
											position: 'relative'
										}}
									>
										<div
											data-group=""
											data-def={def.id}
											style={{
												width: def.size.w,
												height: def.size.h,
												transform: scale < 1 ? `scale(${scale})` : undefined,
												transformOrigin: 'top left'
											}}
										>
											<FlowNode
												node={child}
												parentKind="col"
												prefix="preset/"
												renderLeaf={renderLeaf}
												fill
											/>
										</div>
									</div>
								</div>
								<figcaption>{sack.name}</figcaption>
							</div>
						</figure>
					);
				})}
			</div>
		</TelemetryHubContext.Provider>
	);
}
