/**
 * The values the `--vscode-*` variables take in VS Code's built-in themes, for the variables the
 * detail panel's stylesheet uses in `color` and `background-color`, plus the ones its previous
 * stylesheet used, which the contrast tests replay to prove they catch that stylesheet's failures.
 * `null` means the theme does not define the colour, so the variable is absent and a
 * `var(--x, fallback)` takes its fallback.
 *
 * Read from the VS Code 1.138 install: `extensions/theme-defaults/themes/*.json` merged along
 * `include`, and the colour registry defaults in the workbench for what a theme leaves unset
 * (`descriptionForeground` in the high-contrast themes is the foreground at 70% opacity,
 * `symbolIcon.propertyForeground` defaults to the foreground). Light Modern and Dark Modern are
 * the long-standing defaults; the 2026 pair ships in 1.138; the engine range starts at 1.95.
 */
export type ThemeColors = Readonly<Record<string, string | null>>;

export interface ThemeDefaults {
  readonly name: string;
  readonly colors: ThemeColors;
}

export const EDITOR_BACKGROUND_VARIABLE = '--vscode-editor-background';
export const FOREGROUND_VARIABLE = '--vscode-foreground';

export const BUILT_IN_THEMES: readonly ThemeDefaults[] = [
  {
    name: 'Light Modern',
    colors: {
      '--vscode-foreground': '#3B3B3B',
      '--vscode-editor-background': '#FFFFFF',
      '--vscode-badge-background': '#CCCCCC',
      '--vscode-badge-foreground': '#3B3B3B',
      '--vscode-descriptionForeground': '#3B3B3B',
      '--vscode-textLink-foreground': '#005FB8',
      '--vscode-textLink-activeForeground': '#005FB8',
      '--vscode-textCodeBlock-background': '#F8F8F8',
      '--vscode-symbolIcon-propertyForeground': '#3B3B3B',
      '--vscode-button-foreground': '#FFFFFF',
      '--vscode-button-background': '#005FB8',
      '--vscode-button-hoverBackground': '#0258A8',
      '--vscode-button-secondaryBackground': '#E5E5E5',
      '--vscode-button-secondaryForeground': '#3B3B3B',
      '--vscode-button-secondaryHoverBackground': '#CCCCCC',
      '--vscode-disabledForeground': '#61616180',
      '--vscode-textBlockQuote-background': '#F8F8F8',
      '--vscode-textBlockQuote-border': '#E5E5E5',
    },
  },
  {
    name: 'Dark Modern',
    colors: {
      '--vscode-foreground': '#CCCCCC',
      '--vscode-editor-background': '#1F1F1F',
      '--vscode-badge-background': '#616161',
      '--vscode-badge-foreground': '#F8F8F8',
      '--vscode-descriptionForeground': '#9D9D9D',
      '--vscode-textLink-foreground': '#4DAAFC',
      '--vscode-textLink-activeForeground': '#4DAAFC',
      '--vscode-textCodeBlock-background': '#2B2B2B',
      '--vscode-symbolIcon-propertyForeground': '#CCCCCC',
      '--vscode-button-foreground': '#FFFFFF',
      '--vscode-button-background': '#0078D4',
      '--vscode-button-hoverBackground': '#026EC1',
      '--vscode-button-secondaryBackground': '#00000000',
      '--vscode-button-secondaryForeground': '#CCCCCC',
      '--vscode-button-secondaryHoverBackground': '#2B2B2B',
      '--vscode-disabledForeground': '#CCCCCC80',
      '--vscode-textBlockQuote-background': '#2B2B2B',
      '--vscode-textBlockQuote-border': '#616161',
    },
  },
  {
    name: 'Light 2026',
    colors: {
      '--vscode-foreground': '#202020',
      '--vscode-editor-background': '#FFFFFF',
      '--vscode-badge-background': '#0069CC',
      '--vscode-badge-foreground': '#FFFFFF',
      '--vscode-descriptionForeground': '#606060',
      '--vscode-textLink-foreground': '#0069CC',
      '--vscode-textLink-activeForeground': '#0069CC',
      '--vscode-textCodeBlock-background': '#EAEAEA',
      '--vscode-symbolIcon-propertyForeground': '#202020',
      '--vscode-button-foreground': '#FFFFFF',
      '--vscode-button-background': '#0069CC',
      '--vscode-button-hoverBackground': '#0063C1',
      '--vscode-button-secondaryBackground': '#EAEAEA',
      '--vscode-button-secondaryForeground': '#202020',
      '--vscode-button-secondaryHoverBackground': '#F2F3F4',
      '--vscode-disabledForeground': '#BBBBBB',
      '--vscode-textBlockQuote-background': '#EAEAEA',
      '--vscode-textBlockQuote-border': '#F0F1F2',
    },
  },
  {
    name: 'Dark 2026',
    colors: {
      '--vscode-foreground': '#BFBFBF',
      '--vscode-editor-background': '#121314',
      '--vscode-badge-background': '#307E9F',
      '--vscode-badge-foreground': '#FFFFFF',
      '--vscode-descriptionForeground': '#8C8C8C',
      '--vscode-textLink-foreground': '#48A0C7',
      '--vscode-textLink-activeForeground': '#53A5CA',
      '--vscode-textCodeBlock-background': '#242526',
      '--vscode-symbolIcon-propertyForeground': '#BFBFBF',
      '--vscode-button-foreground': '#FFFFFF',
      '--vscode-button-background': '#297AA0',
      '--vscode-button-hoverBackground': '#2B7DA3',
      '--vscode-button-secondaryBackground': '#00000000',
      '--vscode-button-secondaryForeground': '#CCCCCC',
      '--vscode-button-secondaryHoverBackground': '#FFFFFF10',
      '--vscode-disabledForeground': '#555555',
      '--vscode-textBlockQuote-background': '#242526',
      '--vscode-textBlockQuote-border': '#2A2B2C',
    },
  },
  {
    name: 'Default High Contrast',
    colors: {
      '--vscode-foreground': '#FFFFFF',
      '--vscode-editor-background': '#000000',
      '--vscode-badge-background': '#000000',
      '--vscode-badge-foreground': '#FFFFFF',
      '--vscode-descriptionForeground': '#FFFFFFB3',
      '--vscode-textLink-foreground': '#21A6FF',
      '--vscode-textLink-activeForeground': '#21A6FF',
      '--vscode-textCodeBlock-background': '#000000',
      '--vscode-symbolIcon-propertyForeground': '#FFFFFF',
      '--vscode-button-foreground': '#FFFFFF',
      '--vscode-button-background': '#000000',
      '--vscode-button-hoverBackground': '#000000',
      '--vscode-button-secondaryBackground': null,
      '--vscode-button-secondaryForeground': '#FFFFFF',
      '--vscode-button-secondaryHoverBackground': null,
      '--vscode-disabledForeground': '#A5A5A5',
      '--vscode-textBlockQuote-background': null,
      '--vscode-textBlockQuote-border': '#FFFFFF',
    },
  },
  {
    name: 'Default High Contrast Light',
    colors: {
      '--vscode-foreground': '#292929',
      '--vscode-editor-background': '#FFFFFF',
      '--vscode-badge-background': '#0F4A85',
      '--vscode-badge-foreground': '#FFFFFF',
      '--vscode-descriptionForeground': '#292929B3',
      '--vscode-textLink-foreground': '#0F4A85',
      '--vscode-textLink-activeForeground': '#0F4A85',
      '--vscode-textCodeBlock-background': '#F2F2F2',
      '--vscode-symbolIcon-propertyForeground': '#292929',
      '--vscode-button-foreground': '#FFFFFF',
      '--vscode-button-background': '#0F4A85',
      '--vscode-button-hoverBackground': '#0F4A85',
      '--vscode-button-secondaryBackground': '#FFFFFF',
      '--vscode-button-secondaryForeground': '#292929',
      '--vscode-button-secondaryHoverBackground': null,
      '--vscode-disabledForeground': '#7F7F7F',
      '--vscode-textBlockQuote-background': '#F2F2F2',
      '--vscode-textBlockQuote-border': '#292929',
    },
  },
];
