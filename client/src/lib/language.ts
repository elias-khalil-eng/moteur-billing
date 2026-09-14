/**
 * The browser side of language selection: what the viewer chose last time, and the
 * `dir` and `lang` attributes that make one stylesheet serve both directions.
 * Kept apart from i18n.ts so the dictionaries stay testable without a DOM.
 */

import { DEFAULT_LANGUAGE } from './i18n.js';
import type { Language } from '../../../lib/types.js';

const STORAGE_KEY = 'moteur.language';

export function readStoredLanguage(): Language {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'ar' || stored === 'en') return stored;
  } catch {
    // Storage can be unavailable; the default is still correct.
  }
  return DEFAULT_LANGUAGE;
}

export function storeLanguage(language: Language): void {
  try {
    localStorage.setItem(STORAGE_KEY, language);
  } catch {
    // Not fatal: the choice simply does not survive a reload.
  }
}

export function applyDocumentLanguage(language: Language): void {
  document.documentElement.lang = language;
  document.documentElement.dir = language === 'ar' ? 'rtl' : 'ltr';
}
