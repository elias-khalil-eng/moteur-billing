import { useI18n } from '../app/I18nContext.js';

export function LanguageToggle({ className }: { className?: string }) {
  const { t, toggleLanguage } = useI18n();
  return (
    <button type="button" className={`language-toggle ${className ?? ''}`} onClick={toggleLanguage}>
      {t('app.language')}
    </button>
  );
}
