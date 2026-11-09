/**
 * The colours of the type badges on the stats dashboard. Each entry type has its own background so
 * the eye can tell them apart, and the text colour is chosen for that background: white on #ffca28
 * (command) is 1.5:1, where WCAG AA asks for 4.5:1 for text this small.
 */

export const TYPE_COLORS: Readonly<Record<string, string>> = {
  skill: '#00bcd4',
  agent: '#2196f3',
  command: '#ffca28',
  plugin: '#4caf50',
  rule: '#e040fb',
  hook: '#ef5350',
};

export interface BadgeColors {
  readonly backgroundColor: string;
  readonly color: string;
}

const BLACK = '#000000';
const WHITE = '#ffffff';

/** A type with no colour of its own gets the pair the theme defines for badges, readable in every theme. */
const THEME_BADGE: BadgeColors = {
  backgroundColor: 'var(--vscode-badge-background)',
  color: 'var(--vscode-badge-foreground)',
};

const HEX_COLOR = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i;
const MAX_CHANNEL = 255;

/** WCAG 2.x relative luminance: the sRGB transfer function, then the weights of the three channels. */
const SRGB_LINEAR_CUTOFF = 0.04045;
const SRGB_LINEAR_DIVISOR = 12.92;
const SRGB_GAMMA_OFFSET = 0.055;
const SRGB_GAMMA_DIVISOR = 1.055;
const SRGB_GAMMA = 2.4;
const RED_WEIGHT = 0.2126;
const GREEN_WEIGHT = 0.7152;
const BLUE_WEIGHT = 0.0722;
const FLARE = 0.05;

function linearChannel(hexPair: string): number {
  const value = parseInt(hexPair, 16) / MAX_CHANNEL;
  return value <= SRGB_LINEAR_CUTOFF
    ? value / SRGB_LINEAR_DIVISOR
    : ((value + SRGB_GAMMA_OFFSET) / SRGB_GAMMA_DIVISOR) ** SRGB_GAMMA;
}

function luminance(color: string): number {
  const match = HEX_COLOR.exec(color);
  if (match === null) throw new Error(`not a #rrggbb colour: ${color}`);
  const [, red, green, blue] = match;
  return (
    RED_WEIGHT * linearChannel(red) +
    GREEN_WEIGHT * linearChannel(green) +
    BLUE_WEIGHT * linearChannel(blue)
  );
}

/** The WCAG contrast ratio of two #rrggbb colours, from 1 (the same) to 21 (black on white). */
export function contrastRatio(first: string, second: string): number {
  const [lighter, darker] = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (lighter + FLARE) / (darker + FLARE);
}

/** Black or white, whichever reads better on `background` (#rrggbb). Never below 4.58:1. */
export function readableTextColor(background: string): string {
  return contrastRatio(BLACK, background) >= contrastRatio(WHITE, background) ? BLACK : WHITE;
}

/**
 * The colours of the badge for an entry of `type`. `hasOwnProperty`, not a lookup: a type called
 * `constructor` or `__proto__` has no colour of its own and must not find one on the prototype.
 * (`Object.hasOwn` is ES2022 and this project's library is ES2020.)
 */
export function badgeColors(type: string): BadgeColors {
  if (!Object.prototype.hasOwnProperty.call(TYPE_COLORS, type)) return THEME_BADGE;
  const backgroundColor = TYPE_COLORS[type];
  return { backgroundColor, color: readableTextColor(backgroundColor) };
}
