import { useState } from 'react';
import { useI18n } from '../app/I18nContext.js';

interface PinDialogProps {
  pin: string;
  subscriberName: string;
  subscriberCode: string;
  onClose: () => void;
}

/**
 * The PIN is shown here once and never again: the server returns it only in the
 * response that created or reset it, and stores nothing but the hash.
 */
export function PinDialog({ pin, subscriberName, subscriberCode, onClose }: PinDialogProps) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(pin);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="dialog-backdrop" role="dialog" aria-modal="true" aria-label={t('pin.title')}>
      <div className="dialog card">
        <h2>{t('pin.title')}</h2>
        <p className="dialog__explain">{t('pin.explain')}</p>

        <div className="pin-slip">
          <p className="pin-slip__title">{t('pin.slipTitle')}</p>
          <p className="pin-slip__line">
            <span>{t('subscriber.name')}</span>
            <strong>{subscriberName}</strong>
          </p>
          <p className="pin-slip__line">
            <span>{t('subscriber.code')}</span>
            <strong>{subscriberCode}</strong>
          </p>
          <p className="pin-slip__line pin-slip__line--pin">
            <span>{t('pin.title')}</span>
            <strong>{pin}</strong>
          </p>
        </div>

        <div className="dialog__actions">
          <button type="button" className="button" onClick={copy}>
            {copied ? t('pin.copied') : t('pin.copy')}
          </button>
          <button type="button" className="button" onClick={() => window.print()}>
            {t('pin.print')}
          </button>
          <button type="button" className="button button--primary" onClick={onClose}>
            {t('app.close')}
          </button>
        </div>
      </div>
    </div>
  );
}
