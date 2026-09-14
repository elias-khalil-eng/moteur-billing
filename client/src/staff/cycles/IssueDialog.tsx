import { useState } from 'react';
import { ApiError, request } from '../../lib/api.js';
import { useI18n } from '../../app/I18nContext.js';
import { useResource } from '../../lib/useResource.js';
import { formatLbp, formatUsd } from '../../lib/format.js';
import { Spinner } from '../../components/Spinner.js';

interface Preview {
  readingsEntered: number;
  missingReadings: number;
  totalUsdCents: number;
  totalLbp: number;
  withEstimates: { billsCreated: number; totalUsdCents: number; totalLbp: number };
}

interface IssueResult {
  billsCreated: number;
  estimatedReadings: number;
  alreadyIssued: boolean;
}

interface IssueDialogProps {
  cycleId: number;
  onClose: () => void;
  onIssued: (result: IssueResult) => void;
}

/**
 * Shows what issuing will produce before it happens: how many bills, the totals in
 * both currencies, and how many readings would be estimated. Every figure comes
 * from the server.
 */
export function IssueDialog({ cycleId, onClose, onIssued }: IssueDialogProps) {
  const { t, language } = useI18n();
  const preview = useResource<Preview>(`/cycles/${cycleId}/issue-preview`, {}, `preview:${cycleId}`);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function issue(estimateMissing: boolean) {
    setBusy(true);
    setError(null);
    try {
      const result = await request<IssueResult>(`/cycles/${cycleId}/issue`, {
        method: 'POST',
        body: { estimateMissing },
      });
      onIssued(result);
    } catch (err) {
      setError(err instanceof ApiError ? err.localized(language) : String(err));
    } finally {
      setBusy(false);
    }
  }

  const data = preview.data;
  const missing = data?.missingReadings ?? 0;

  return (
    <div className="dialog-backdrop" role="dialog" aria-modal="true">
      <div className="dialog card">
        <h2>{t('issue.confirmTitle')}</h2>

        {preview.loading ? <Spinner /> : null}

        {data !== null ? (
          <>
            <p>
              {t('issue.summary', {
                count: missing > 0 ? data.withEstimates.billsCreated : data.readingsEntered,
                usd: formatUsd(missing > 0 ? data.withEstimates.totalUsdCents : data.totalUsdCents),
                lbp: formatLbp(
                  missing > 0 ? data.withEstimates.totalLbp : data.totalLbp,
                  language,
                ),
              })}
            </p>
            {missing > 0 ? (
              <p className="dialog__explain">{t('issue.missing', { count: missing })}</p>
            ) : null}
          </>
        ) : null}

        {error !== null ? <p className="field__error">{error}</p> : null}

        <div className="dialog__actions">
          <button type="button" className="button" onClick={onClose} disabled={busy}>
            {t('app.cancel')}
          </button>
          <button
            type="button"
            className="button button--primary"
            disabled={busy || data === null}
            onClick={() => void issue(missing > 0)}
          >
            {missing > 0 ? t('issue.withEstimates') : t('issue.action')}
          </button>
        </div>
      </div>
    </div>
  );
}
