import themes from '../../config/ui.themes.json';

export const THEMES = ['light', 'dark'] as const;
export type Theme = typeof THEMES[number];
export const THEME_LABELS = { light: '日间', dark: '夜间' };
export const THEME_STORAGE_KEY = 'codenode.theme';
export const DEFAULT_THEME: Theme = 'dark';

export function normalizeTheme(value: unknown): Theme {
  return value === 'light' || value === 'bright' ? 'light' : DEFAULT_THEME;
}

export function themeTokens(theme: Theme): Record<string, string> {
  return themes[theme];
}
