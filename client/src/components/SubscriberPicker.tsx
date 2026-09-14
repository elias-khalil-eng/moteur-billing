import { useState } from 'react';
import { useI18n } from '../app/I18nContext.js';
import { useResource } from '../lib/useResource.js';
import { formatUsd } from '../lib/format.js';
import type { Paged, SubscriberWithBalance } from '../../../lib/types.js';

interface SubscriberPickerProps {
  onPick: (subscriber: SubscriberWithBalance) => void;
  label: string;
}

/** Search-and-choose used wherever staff act on one subscriber. */
export function SubscriberPicker({ onPick, label }: SubscriberPickerProps) {
  const { t } = useI18n();
  const [search, setSearch] = useState('');
  const list = useResource<Paged<SubscriberWithBalance>>(
    '/subscribers',
    { query: { q: search || undefined, pageSize: 25 } },
    `picker:${search}`,
  );

  return (
    <div className="picker">
      <input
        className="field__input"
        type="search"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder={t('subscribers.searchPlaceholder')}
        aria-label={label}
        inputMode="search"
      />
      {search.trim() === '' ? null : (
        <ul className="list picker__results">
          {(list.data?.items ?? []).slice(0, 8).map((subscriber) => (
            <li key={subscriber.id}>
              <button
                type="button"
                className="list__row picker__option"
                onClick={() => {
                  onPick(subscriber);
                  setSearch('');
                }}
              >
                <span className="list__main">
                  <strong>{subscriber.name}</strong>
                  <span className="list__meta">{subscriber.code}</span>
                </span>
                <span className="list__amount">{formatUsd(subscriber.balanceUsdCents)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
