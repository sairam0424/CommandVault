const SCRIPT_UNSAFE_CHARACTERS = /[<>&\u2028\u2029]/g;

/**
 * `value` as JSON that is safe to paste into an inline `<script>` block. JSON.stringify leaves `<`
 * alone, so a string containing `</script>` ends the block early and `<!--` can hide the end of it.
 * Each character that matters to the HTML parser (and the two line separators older JavaScript
 * engines reject inside string literals) becomes its \uXXXX escape, which JSON.parse reads back as
 * the same character.
 */
export function toScriptJson(value: unknown): string {
  const json = JSON.stringify(value) ?? 'null';
  return json.replace(SCRIPT_UNSAFE_CHARACTERS, (character) => {
    return `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`;
  });
}
