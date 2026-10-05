/**
 * Entry names, descriptions, tags and content come from files that third parties write (installed
 * plugins, `vault sync` bundles), so they are data, never markup. Everything a provider puts into a
 * MarkdownString goes through one of the two functions here.
 */

const WHITESPACE_AND_CONTROL_RUNS = /[\s\u0000-\u001f\u007f]+/g;

/** CommonMark/GFM punctuation that starts a link, image, autolink, emphasis, heading, list, table... */
const MARKDOWN_SYNTAX = /[\\`*_{}[\]()<>#+\-.!|~&:=@]/g;

const MIN_FENCE_LENGTH = 3;
const FENCE_CHARACTER = '`';

/**
 * `text` as one line of plain text inside markdown: whitespace runs (newlines included) become a
 * single space so it cannot open a block, and every punctuation character that could start markup
 * is backslash-escaped, so `[x](command:...)`, `<command:...>`, `![](...)` and bare URLs render as
 * the characters they are.
 */
export function escapeMarkdownInline(text: string): string {
  return text.replace(WHITESPACE_AND_CONTROL_RUNS, ' ').trim().replace(MARKDOWN_SYNTAX, '\\$&');
}

/**
 * `code` in a fenced block whose fence is longer than any run of backticks inside it, so nothing in
 * `code` can close the fence and start being read as markdown. Every run counts, wherever it is:
 * VS Code's appendCodeblock only counts runs at the start of a line, and CommonMark lets a closing
 * fence be indented by up to three spaces, so an indented ``` still ends a three-backtick block.
 */
export function fencedCodeBlock(code: string): string {
  const longestRun = (code.match(/`+/g) ?? []).reduce(
    (longest, run) => Math.max(longest, run.length),
    0,
  );
  const fence = FENCE_CHARACTER.repeat(Math.max(MIN_FENCE_LENGTH, longestRun + 1));
  return `${fence}text\n${code}\n${fence}\n`;
}
