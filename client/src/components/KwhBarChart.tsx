import { useI18n } from '../app/I18nContext.js';
import { formatKwh } from '../lib/format.js';

interface Point {
  label: string;
  kwh: number;
}

/**
 * A plain SVG bar chart. Inline rather than a charting library: twelve bars do
 * not justify a dependency on a phone connection in Lebanon.
 */
export function KwhBarChart({ points, title }: { points: Point[]; title: string }) {
  const { language } = useI18n();
  if (points.length === 0) return null;

  const max = Math.max(...points.map((point) => point.kwh), 1);

  return (
    <figure className="chart">
      <figcaption className="chart__title">{title}</figcaption>
      <div className="chart__bars" role="img" aria-label={title}>
        {points.map((point) => (
          <div className="chart__bar-slot" key={point.label}>
            <div
              className="chart__bar"
              style={{ blockSize: `${Math.max(2, (point.kwh / max) * 100)}%` }}
              title={`${point.label}: ${formatKwh(point.kwh, language)}`}
            />
            <span className="chart__label">{point.label}</span>
          </div>
        ))}
      </div>
    </figure>
  );
}
