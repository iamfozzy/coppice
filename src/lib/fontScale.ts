export const DEFAULT_APP_FONT_SIZE = 16;
const MIN_APP_FONT_SIZE = 10;
const MAX_APP_FONT_SIZE = 24;

const APP_FONT_SIZES = [9, 10, 11, 12, 13, 14, 15, 16, 18, 20, 24, 30, 36, 48, 60, 72, 96, 128] as const;
const TAILWIND_TEXT_SIZES: Record<string, number> = {
  xs: 12,
  sm: 14,
  base: 16,
  lg: 18,
  xl: 20,
  "2xl": 24,
  "3xl": 30,
  "4xl": 36,
  "5xl": 48,
  "6xl": 60,
  "7xl": 72,
  "8xl": 96,
  "9xl": 128,
};

export function normalizeAppFontSize(size: number | null | undefined): number {
  if (!Number.isFinite(size) || !size) return DEFAULT_APP_FONT_SIZE;
  return Math.min(MAX_APP_FONT_SIZE, Math.max(MIN_APP_FONT_SIZE, size));
}

function roundPx(value: number): string {
  return `${Math.round(value * 1000) / 1000}px`;
}

export function getAppFontScale(appFontSize: number | null | undefined): number {
  return normalizeAppFontSize(appFontSize) / DEFAULT_APP_FONT_SIZE;
}

export function getScaledFontSize(basePx: number, appFontSize: number | null | undefined): number {
  return Math.round(basePx * getAppFontScale(appFontSize) * 10) / 10;
}

export function applyAppFontSize(appFontSize: number | null | undefined): void {
  const scale = getAppFontScale(appFontSize);
  const root = document.documentElement;

  root.style.setProperty("--app-font-scale", String(scale));
  root.style.setProperty("--app-font-base", roundPx(DEFAULT_APP_FONT_SIZE * scale));

  for (const size of APP_FONT_SIZES) {
    root.style.setProperty(`--app-font-${size}`, roundPx(size * scale));
  }

  for (const [name, size] of Object.entries(TAILWIND_TEXT_SIZES)) {
    root.style.setProperty(`--text-${name}`, roundPx(size * scale));
  }
}
