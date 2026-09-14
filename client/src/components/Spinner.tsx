import { useI18n } from '../app/I18nContext.js';

export function Spinner({ label }: { label?: string }) {
  const { t } = useI18n();
  return (
    <div className="spinner" role="status">
      <span className="spinner__dot" />
      <span className="spinner__text">{label ?? t('app.loading')}</span>
    </div>
  );
}
