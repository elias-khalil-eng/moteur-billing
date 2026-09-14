import { useState } from 'react';
import type { FormEvent } from 'react';
import { ApiError, request } from '../../lib/api.js';
import { useI18n } from '../../app/I18nContext.js';
import { useToast } from '../../app/ToastContext.js';
import { useResource } from '../../lib/useResource.js';
import { formatDate, formatUsd, parseUsdToCents } from '../../lib/format.js';
import { Field } from '../../components/Field.js';
import { Spinner } from '../../components/Spinner.js';
import { EmptyState } from '../../components/EmptyState.js';
import type { Expense, ExpenseCategory } from '../../../../lib/types.js';

const CATEGORIES: ExpenseCategory[] = ['diesel', 'maintenance', 'salary', 'other'];

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function ExpensesScreen() {
  const { t, language } = useI18n();
  const toast = useToast();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [category, setCategory] = useState<ExpenseCategory>('diesel');
  const [amount, setAmount] = useState('');
  const [liters, setLiters] = useState('');
  const [vendor, setVendor] = useState('');
  const [spentAt, setSpentAt] = useState(today());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const list = useResource<{ expenses: Expense[] }>(
    '/expenses',
    { query: { from: from || undefined, to: to || undefined } },
    `expenses:${from}:${to}`,
  );

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const amountUsdCents = parseUsdToCents(amount);
    if (amountUsdCents === null) {
      setError(t('expenses.amount'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await request('/expenses', {
        method: 'POST',
        body: {
          category,
          amountUsdCents,
          spentAt,
          ...(category === 'diesel' && liters.trim() !== '' ? { liters: Number(liters) } : {}),
          ...(vendor.trim() === '' ? {} : { vendor: vendor.trim() }),
        },
      });
      toast.show(t('expenses.saved'), 'success');
      setAmount('');
      setLiters('');
      setVendor('');
      list.reload();
    } catch (err) {
      const message = err instanceof ApiError ? err.localized(language) : String(err);
      setError(message);
      toast.show(message, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: number) {
    if (!window.confirm(t('expenses.deleteConfirm'))) return;
    await request(`/expenses/${id}`, { method: 'DELETE' });
    toast.show(t('expenses.deleted'), 'success');
    list.reload();
  }

  return (
    <>
      <form className="card" onSubmit={onSubmit}>
        <h2 className="card__title">{t('expenses.add')}</h2>

        <div className="segmented" role="group" aria-label={t('expenses.category')}>
          {CATEGORIES.map((option) => (
            <button
              key={option}
              type="button"
              className={`segmented__option ${category === option ? 'segmented__option--on' : ''}`}
              onClick={() => setCategory(option)}
            >
              {t(`expenses.category.${option}`)}
            </button>
          ))}
        </div>

        <Field
          label={t('expenses.amount')}
          value={amount}
          inputMode="decimal"
          onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))}
          error={error}
        />
        {category === 'diesel' ? (
          <Field
            label={t('expenses.liters')}
            value={liters}
            inputMode="decimal"
            onChange={(e) => setLiters(e.target.value.replace(/[^\d.]/g, ''))}
          />
        ) : null}
        <Field
          label={t('expenses.vendor')}
          value={vendor}
          onChange={(e) => setVendor(e.target.value)}
        />
        <Field
          label={t('expenses.date')}
          type="date"
          value={spentAt}
          onChange={(e) => setSpentAt(e.target.value)}
        />

        <div className="form-actions">
          <button className="button button--primary" type="submit" disabled={busy}>
            {t('app.save')}
          </button>
        </div>
      </form>

      <section className="toolbar">
        <input
          className="field__input"
          type="date"
          value={from}
          aria-label={t('expenses.date')}
          onChange={(e) => setFrom(e.target.value)}
        />
        <input
          className="field__input"
          type="date"
          value={to}
          aria-label={t('expenses.date')}
          onChange={(e) => setTo(e.target.value)}
        />
      </section>

      {list.loading ? <Spinner /> : null}

      {list.data !== null && list.data.expenses.length === 0 ? (
        <EmptyState message={t('expenses.empty')} />
      ) : null}

      {list.data !== null && list.data.expenses.length > 0 ? (
        <ul className="list">
          {list.data.expenses.map((expense) => (
            <li key={expense.id} className="list__row">
              <span className="list__main">
                <strong>{t(`expenses.category.${expense.category}`)}</strong>
                <span className="list__meta">
                  {formatDate(`${expense.spentAt}T00:00:00Z`, language)}
                  {expense.vendor === null ? '' : ` · ${expense.vendor}`}
                  {expense.liters === null ? '' : ` · ${expense.liters} L`}
                </span>
              </span>
              <span className="list__amount">
                {formatUsd(expense.amountUsdCents)}
                <button
                  type="button"
                  className="link-button"
                  onClick={() => void remove(expense.id)}
                >
                  {t('app.cancel')}
                </button>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}
