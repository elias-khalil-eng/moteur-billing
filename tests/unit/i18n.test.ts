import { describe, it, expect } from 'vitest';
import { dictionaries, translate, DEFAULT_LANGUAGE } from '../../client/src/lib/i18n.js';

describe('the two dictionaries', () => {
  it('cover exactly the same keys, so a screen is never half translated', () => {
    const ar = Object.keys(dictionaries.ar).sort();
    const en = Object.keys(dictionaries.en).sort();
    expect(ar).toEqual(en);
  });

  it('has no empty string anywhere', () => {
    for (const [language, dictionary] of Object.entries(dictionaries)) {
      for (const [key, value] of Object.entries(dictionary)) {
        expect(value.trim(), `${language}.${key}`).not.toBe('');
      }
    }
  });

  it('keeps the Arabic and English text different, so nothing was left untranslated', () => {
    // Latin-script product words are allowed to match; Arabic prose must not.
    const allowedIdentical = new Set(['app.language']);
    for (const key of Object.keys(dictionaries.en) as (keyof typeof dictionaries.en)[]) {
      if (allowedIdentical.has(key)) continue;
      const en = dictionaries.en[key];
      const ar = dictionaries.ar[key];
      if (/^[\d\s.,%$/-]+$/.test(en)) continue;
      expect(ar, `key ${key}`).not.toBe(en);
    }
  });

  it('uses Arabic script for every Arabic string that carries words', () => {
    // app.language is the label of the toggle, which names the other language.
    const latinByDesign = new Set(['app.language']);
    for (const key of Object.keys(dictionaries.ar) as (keyof typeof dictionaries.ar)[]) {
      if (latinByDesign.has(key)) continue;
      const value = dictionaries.ar[key];
      if (/^[\d\s.,%$/{}-]+$/.test(value)) continue;
      expect(/[؀-ۿ]/.test(value), `key ${key} has no Arabic letters`).toBe(true);
    }
  });

  it('keeps the same placeholders in both languages', () => {
    const placeholders = (value: string) => (value.match(/\{(\w+)\}/g) ?? []).sort();
    for (const key of Object.keys(dictionaries.en) as (keyof typeof dictionaries.en)[]) {
      expect(placeholders(dictionaries.ar[key]), `key ${key}`).toEqual(
        placeholders(dictionaries.en[key]),
      );
    }
  });
});

describe('translate', () => {
  it('defaults to Arabic', () => {
    expect(DEFAULT_LANGUAGE).toBe('ar');
  });

  it('substitutes placeholders', () => {
    expect(translate('en', 'cycle.progress', { done: 412, total: 530 })).toBe(
      '412 of 530 readings',
    );
    expect(translate('ar', 'cycle.progress', { done: 412, total: 530 })).toContain('412');
  });

  it('leaves an unknown placeholder alone rather than printing undefined', () => {
    expect(translate('en', 'cycle.progress', { done: 412 })).toContain('{total}');
  });
});
