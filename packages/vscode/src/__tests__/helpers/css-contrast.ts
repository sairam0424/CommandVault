import {
  EDITOR_BACKGROUND_VARIABLE,
  FOREGROUND_VARIABLE,
  type ThemeColors,
} from './vscode-theme-defaults';

/**
 * Just enough CSS to answer "which text sits on which background, and is it readable": it reads
 * flat rules, resolves `var(--vscode-*, fallback)` against a theme's colours, and measures the
 * WCAG contrast ratio of every rule that sets `color` or `background-color`. An element with no
 * colour of its own inherits the body's foreground over the editor background, as in the page.
 */

interface Rgba {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

export interface TextPair {
  readonly selector: string;
  readonly foreground: string;
  readonly background: string;
  readonly ratio: number;
}

type Declarations = Readonly<Record<string, string>>;

export const MINIMUM_TEXT_CONTRAST = 4.5;

const COLOR_PROPERTIES = /^(color|background|background-color|border(-[a-z]+)*|outline(-color)?)$/;
const COLOR_LITERAL =
  /#[0-9a-f]{3,8}\b|\b(rgba?|hsla?)\(|\b(white|black|gr[ae]y|red|green|blue|yellow|orange|purple)\b/i;

function parseRules(css: string): Map<string, Declarations> {
  const rules = new Map<string, Declarations>();
  const flat = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const [, selectorList, body] of flat.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const declarations: Record<string, string> = {};
    for (const declaration of body.split(';')) {
      const colon = declaration.indexOf(':');
      if (colon > 0) {
        declarations[declaration.slice(0, colon).trim()] = declaration.slice(colon + 1).trim();
      }
    }
    for (const selector of selectorList.split(',')) {
      const key = selector.trim();
      rules.set(key, { ...rules.get(key), ...declarations });
    }
  }
  return rules;
}

/** Colour declarations whose value still contains a colour literal once `var(...)` is removed. */
export function hardCodedColors(css: string): string[] {
  const found: string[] = [];
  for (const [selector, declarations] of parseRules(css)) {
    for (const [property, value] of Object.entries(declarations)) {
      const literal = COLOR_PROPERTIES.test(property) && COLOR_LITERAL.exec(withoutVar(value));
      if (literal) found.push(`${selector} { ${property}: ${value} }`);
    }
  }
  return found;
}

/** `value` with each (possibly nested) `var(...)` cut out. */
function withoutVar(value: string): string {
  let result = '';
  for (let index = 0; index < value.length; index += 1) {
    if (value.startsWith('var(', index)) {
      index = closingParenthesis(value, index + 3);
    } else {
      result += value[index];
    }
  }
  return result;
}

function closingParenthesis(text: string, open: number): number {
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    if (text[index] === '(') depth += 1;
    if (text[index] === ')') depth -= 1;
    if (depth === 0) return index;
  }
  throw new Error(`unbalanced parenthesis in: ${text}`);
}

function parseHex(hex: string): Rgba {
  const digits = hex.slice(1);
  const full = digits.length <= 4 ? [...digits].map((d) => d + d).join('') : digits;
  const channel = (offset: number): number => parseInt(full.slice(offset, offset + 2), 16);
  return {
    r: channel(0),
    g: channel(2),
    b: channel(4),
    a: full.length === 8 ? channel(6) / 255 : 1,
  };
}

/** The colour a declaration value computes to: undefined when it is invalid or inherited. */
function resolveColor(value: string, theme: ThemeColors): Rgba | undefined {
  const text = value.trim();
  if (text === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  if (text === 'inherit' || text === 'currentColor') return undefined;
  if (/^#[0-9a-f]{3,8}$/i.test(text)) return parseHex(text);
  if (!text.startsWith('var(')) throw new Error(`unsupported colour value: ${value}`);

  const inner = text.slice(4, closingParenthesis(text, 3));
  const comma = inner.indexOf(',');
  const name = (comma === -1 ? inner : inner.slice(0, comma)).trim();
  const fallback = comma === -1 ? undefined : inner.slice(comma + 1);
  if (!(name in theme)) throw new Error(`the theme table has no entry for ${name}`);
  const defined = theme[name];
  if (defined) return parseHex(defined);
  return fallback === undefined ? undefined : resolveColor(fallback, theme);
}

function over(top: Rgba, bottom: Rgba): Rgba {
  const mix = (t: number, b: number): number => top.a * t + (1 - top.a) * b;
  return { r: mix(top.r, bottom.r), g: mix(top.g, bottom.g), b: mix(top.b, bottom.b), a: 1 };
}

function luminance({ r, g, b }: Rgba): number {
  const linear = (channel: number): number => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

export function contrastRatio(foreground: Rgba, background: Rgba): number {
  const [lighter, darker] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

function hexOf({ r, g, b }: Rgba): string {
  return `#${[r, g, b].map((c) => Math.round(c).toString(16).padStart(2, '0')).join('')}`;
}

/**
 * Every text/background pair the stylesheet sets in `theme`, with `:hover` states merged over
 * their base rule. Rules that set neither `color` nor `background-color` are not pairs.
 */
export function textPairs(css: string, theme: ThemeColors): TextPair[] {
  const rules = parseRules(css);
  const page = over(
    resolveColor(`var(${EDITOR_BACKGROUND_VARIABLE})`, theme) ?? { r: 255, g: 255, b: 255, a: 1 },
    { r: 255, g: 255, b: 255, a: 1 },
  );
  const bodyForeground = over(
    resolveColor(`var(${FOREGROUND_VARIABLE})`, theme) ?? { r: 0, g: 0, b: 0, a: 1 },
    page,
  );

  const pairs: TextPair[] = [];
  for (const [selector, own] of rules) {
    if (selector === 'body' || !('color' in own || 'background-color' in own)) continue;
    const declared: Declarations = { ...rules.get(selector.replace(/:hover$/, '')), ...own };
    const background = over(
      resolveColor(declared['background-color'] ?? 'transparent', theme) ?? {
        r: 0,
        g: 0,
        b: 0,
        a: 0,
      },
      page,
    );
    const foreground = over(
      (declared.color ? resolveColor(declared.color, theme) : undefined) ?? bodyForeground,
      background,
    );
    pairs.push({
      selector,
      foreground: hexOf(foreground),
      background: hexOf(background),
      ratio: contrastRatio(foreground, background),
    });
  }
  return pairs;
}

export function failingPairs(css: string, theme: ThemeColors): TextPair[] {
  return textPairs(css, theme).filter((pair) => pair.ratio < MINIMUM_TEXT_CONTRAST);
}
