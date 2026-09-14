import { useEffect, useState } from 'react';
import { useI18n } from '../../app/I18nContext.js';
import { formatKwh, formatNumber } from '../../lib/format.js';
import { readingQueue } from '../../lib/readingQueue.js';
import type { QueueEntry } from '../../lib/readingQueue.js';
import type { RouteRow } from '../../../../lib/types.js';

interface RouteRowItemProps {
  cycleId: number;
  row: RouteRow;
  queued: QueueEntry | undefined;
}

/**
 * One meter. Typing a value and leaving the field sends it; the row then shows
 * what the server accepted, or what is still waiting to be sent.
 */
export function RouteRowItem({ cycleId, row, queued }: RouteRowItemProps) {
  const { t, language } = useI18n();
  const [value, setValue] = useState(
    row.currentValue === null ? '' : String(row.currentValue),
  );
  const [meterReset, setMeterReset] = useState(row.meterReset ?? false);
  const [note, setNote] = useState(row.note ?? '');

  useEffect(() => {
    if (row.currentValue !== null) setValue(String(row.currentValue));
  }, [row.currentValue]);

  const blocked = queued?.state === 'blocked' ? queued : null;
  const needsConfirm = blocked?.error?.details?.requiresConfirmation === true;
  const saved = queued === undefined && row.currentValue !== null;

  function send(confirmOutlier = false) {
    const currentValue = Number(value);
    if (value.trim() === '' || !Number.isSafeInteger(currentValue)) return;
    void readingQueue.submit({
      cycleId,
      subscriberId: row.subscriberId,
      currentValue,
      meterReset,
      note: note.trim() === '' ? null : note.trim(),
      confirmOutlier,
    });
  }

  return (
    <li className={`route-row ${saved ? 'route-row--done' : ''}`}>
      <div className="route-row__who">
        <strong>{row.name}</strong>
        <span className="list__meta">
          {row.code}
          {row.zone ? ` · ${row.zone}` : ''}
          {` · ${t('route.previous')} ${formatNumber(row.previousValue)}`}
        </span>
      </div>

      <div className="route-row__entry">
        <input
          className="field__input route-row__input"
          type="text"
          inputMode="numeric"
          value={value}
          aria-label={`${t('route.current')} ${row.name}`}
          onChange={(e) => setValue(e.target.value.replace(/[^\d]/g, ''))}
          onBlur={() => send()}
          enterKeyHint="done"
        />
        <span className="route-row__status">
          {queued?.state === 'sending' ? '…' : null}
          {queued?.state === 'queued' ? '↻' : null}
          {saved && row.kwh !== null ? t('route.consumed', { kwh: formatKwh(row.kwh, language) }) : null}
        </span>
      </div>

      <label className="route-row__reset">
        <input
          type="checkbox"
          checked={meterReset}
          onChange={(e) => setMeterReset(e.target.checked)}
        />
        {t('route.meterReset')}
      </label>

      {meterReset ? (
        <input
          className="field__input"
          value={note}
          placeholder={t('route.note')}
          aria-label={t('route.note')}
          onChange={(e) => setNote(e.target.value)}
          onBlur={() => send()}
        />
      ) : null}

      {blocked !== null ? (
        <div className="route-row__problem">
          <p className="field__error">{blocked.error?.message}</p>
          {needsConfirm ? (
            <button type="button" className="button button--primary" onClick={() => send(true)}>
              {t('route.confirmOutlier')}
            </button>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}
