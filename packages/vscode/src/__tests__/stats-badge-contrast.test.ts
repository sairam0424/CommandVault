import { join } from 'node:path';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { KNOWN_ENTRY_TYPES } from '@commandvault/core';
import { beforeAll, describe, expect, it } from 'vitest';
import { MINIMUM_TEXT_CONTRAST, failingPairs, hexContrast } from './helpers/css-contrast';
import { BUILT_IN_THEMES } from './helpers/vscode-theme-defaults';

/**
 * The type badges of the stats dashboard put white text on a fixed colour per entry type, and
 * #ffca28 (command) and #00bcd4 (skill) are too light for it: about 1.5:1 and 2.4:1, where WCAG AA
 * asks for 4.5:1. This renders the real `TopUsedList` from webview/src/StatsApp.tsx and measures
 * the colours it put on each badge, so it fails on whatever colour the component ends up with.
 */

const WEBVIEW_SRC = join(__dirname, '..', '..', 'webview', 'src');

interface TopEntry {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly usageCount: number;
}

interface Badge {
  readonly type: string;
  readonly backgroundColor: string;
  readonly color: string;
}

/** What webview/src/badge-colors.ts exports; it lies outside the package's rootDir, so it is loaded at run time. */
interface BadgeColorsModule {
  readonly TYPE_COLORS: Readonly<Record<string, string>>;
  readonly contrastRatio: (first: string, second: string) => number;
  readonly readableTextColor: (background: string) => string;
  readonly badgeColors: (type: string) => { backgroundColor: string; color: string };
}

let TopUsedList: React.ComponentType<{ readonly entries: readonly TopEntry[] }>;
let badgeColorsModule: BadgeColorsModule;

beforeAll(async () => {
  // StatsApp.tsx reaches the extension host through acquireVsCodeApi() when it is loaded, and the
  // build gives it the JSX runtime where this transform expects React in scope.
  Object.assign(globalThis, { React, acquireVsCodeApi: () => ({ postMessage: () => undefined }) });
  const stats = await import(/* @vite-ignore */ join(WEBVIEW_SRC, 'StatsApp.tsx'));
  TopUsedList = stats.TopUsedList;
  badgeColorsModule = await import(/* @vite-ignore */ join(WEBVIEW_SRC, 'badge-colors.ts'));
});

function declaration(style: string, property: string): string {
  const found = style
    .split(';')
    .map((part) => [part.slice(0, part.indexOf(':')), part.slice(part.indexOf(':') + 1)])
    .find(([name]) => name === property);
  if (!found) throw new Error(`no ${property} in style: ${style}`);
  return found[1];
}

/** The type badge of each row that `TopUsedList` draws for entries of these types. */
function badgesFor(types: readonly string[]): readonly Badge[] {
  const entries = types.map((type, index) => ({
    id: `id-${index}`,
    name: `entry ${index}`,
    type,
    usageCount: index + 1,
  }));
  const html = renderToStaticMarkup(React.createElement(TopUsedList, { entries }));
  return [
    ...html.matchAll(/<span style="([^"]*text-transform:uppercase[^"]*)">([^<]*)<\/span>/g),
  ].map(([, style, type]) => ({
    type,
    backgroundColor: declaration(style, 'background-color'),
    color: declaration(style, 'color'),
  }));
}

/** The measured problems with one badge on one theme: empty means the text is readable on it. */
function problemsWith(badge: Badge): readonly string[] {
  const rule = `.badge { background-color: ${badge.backgroundColor}; color: ${badge.color} }`;
  return BUILT_IN_THEMES.flatMap((theme) =>
    failingPairs(rule, theme.colors).map(
      (pair) =>
        `${badge.type} on ${theme.name}: ${pair.foreground} on ${pair.background} is ` +
        `${pair.ratio.toFixed(2)}:1, under ${MINIMUM_TEXT_CONTRAST}:1`,
    ),
  );
}

describe('stats dashboard: type badges are readable', () => {
  it('draws one badge per entry, for every type the vault knows', () => {
    const badges = badgesFor([...KNOWN_ENTRY_TYPES]);

    expect(badges.map((badge) => badge.type)).toEqual([...KNOWN_ENTRY_TYPES]);
    expect(KNOWN_ENTRY_TYPES.length).toBeGreaterThan(0);
  });

  it.each([...KNOWN_ENTRY_TYPES])('the %s badge meets 4.5:1 on every built-in theme', (type) => {
    const [badge] = badgesFor([type]);

    expect(problemsWith(badge)).toEqual([]);
  });

  it.each([
    ['a type the dashboard has no colour for', 'custom-type'],
    ['a name that is also an Object method', 'toString'],
    ['the name of a property every object has', 'constructor'],
    ['__proto__', '__proto__'],
  ])('a badge for %s takes the theme badge colours, which the theme makes readable', (_n, type) => {
    const [badge] = badgesFor([type]);

    expect(badge.backgroundColor).toBe('var(--vscode-badge-background)');
    expect(badge.color).toBe('var(--vscode-badge-foreground)');
    expect(problemsWith(badge)).toEqual([]);
  });

  it('gives different types different background colours, so the colour still tells them apart', () => {
    const colors = badgesFor([...KNOWN_ENTRY_TYPES]).map((badge) => badge.backgroundColor);

    expect(new Set(colors).size).toBe(KNOWN_ENTRY_TYPES.length);
  });
});

describe('badge colours: the text colour chosen for a background', () => {
  const CHANNEL_STEP = 17;
  const CHANNEL_VALUES = Array.from({ length: 16 }, (_unused, index) => index * CHANNEL_STEP);
  const hex = (channel: number): string => channel.toString(16).padStart(2, '0');
  const GRID = CHANNEL_VALUES.flatMap((red) =>
    CHANNEL_VALUES.flatMap((green) =>
      CHANNEL_VALUES.map((blue) => `#${hex(red)}${hex(green)}${hex(blue)}`),
    ),
  );

  it('reaches 4.5:1 on every colour of a 4,096-colour grid, measured independently of the module', () => {
    const unreadable = GRID.filter(
      (background) =>
        hexContrast(badgeColorsModule.readableTextColor(background), background) <
        MINIMUM_TEXT_CONTRAST,
    );

    expect(unreadable).toEqual([]);
  });

  it('uses black on the light colours and white on the dark ones', () => {
    expect(badgeColorsModule.readableTextColor('#ffffff')).toBe('#000000');
    expect(badgeColorsModule.readableTextColor('#ffca28')).toBe('#000000');
    expect(badgeColorsModule.readableTextColor('#000000')).toBe('#ffffff');
    expect(badgeColorsModule.readableTextColor('#1a237e')).toBe('#ffffff');
  });

  it('measures contrast as WCAG does', () => {
    expect(badgeColorsModule.contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(badgeColorsModule.contrastRatio('#336699', '#336699')).toBe(1);
    expect(badgeColorsModule.contrastRatio('#ffffff', '#ffca28')).toBeCloseTo(
      hexContrast('#ffffff', '#ffca28'),
      5,
    );
  });

  it('refuses a colour it cannot measure instead of guessing', () => {
    expect(() => badgeColorsModule.readableTextColor('var(--vscode-badge-background)')).toThrow(
      /not a #rrggbb colour/,
    );
    expect(() => badgeColorsModule.readableTextColor('#fff')).toThrow(/not a #rrggbb colour/);
  });

  it('colours the badge of every type it has a colour for, and no other', () => {
    for (const [type, background] of Object.entries(badgeColorsModule.TYPE_COLORS)) {
      expect(badgeColorsModule.badgeColors(type)).toEqual({
        backgroundColor: background,
        color: badgeColorsModule.readableTextColor(background),
      });
    }
    expect(Object.keys(badgeColorsModule.TYPE_COLORS).sort()).toEqual(
      [...KNOWN_ENTRY_TYPES].sort(),
    );
  });
});
