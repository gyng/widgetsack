// Image meter (presentational, props-only): renders a resolved image URL with a chosen object-fit. The
// wiring (resolving a wallpapers/ filename → an asset URL) lives in the sibling ImageHost; this just
// draws the <img>. BARE DOM; styled in ImageWidget.css.
import { imageFit } from '../../core/imageSrc';
import './ImageWidget.css';

type Props = { url?: string; fit?: string; alt?: string };

export default function ImageWidget({ url = '', fit = 'contain', alt = '' }: Props) {
	if (!url) {
		return (
			<div className="imagew np-imagew" data-empty="true">
				<span className="img-empty">no image</span>
			</div>
		);
	}
	return (
		<div className="imagew np-imagew">
			<img
				className="img-el"
				src={url}
				alt={alt}
				draggable={false}
				style={{ objectFit: imageFit(fit) }}
			/>
		</div>
	);
}
