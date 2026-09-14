import { Link } from 'react-router-dom';
import { useI18n } from '../app/I18nContext.js';
import type { TranslationKey } from '../lib/i18n.js';

/**
 * A phone's bottom bar holds four items before the labels stop being readable, so
 * the owner's less frequent screens live here rather than being squeezed in.
 */
export function MoreScreen({ items }: { items: { to: string; label: TranslationKey }[] }) {
  const { t } = useI18n();
  return (
    <ul className="list">
      {items.map((item) => (
        <li key={item.to}>
          <Link className="list__row" to={item.to}>
            <span className="list__main">
              <strong>{t(item.label)}</strong>
            </span>
            <span className="list__amount" aria-hidden="true">
              ›
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
