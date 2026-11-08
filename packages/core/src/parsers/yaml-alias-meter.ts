/**
 * Counts the alias nodes the YAML engine itself resolves while it parses a frontmatter block, and
 * stops the parse at the second one that carries a value.
 *
 * Why the engine and not the text: an alias is a reference, so a block of a few hundred bytes can
 * stand for a tree of billions of nodes (nested aliases) or for a 50 KB string repeated 1500 times
 * (about 70 MB of metadata), and the cost only shows later, when the index step serialises the
 * entry. Deciding from the text means re-implementing YAML's tokenizer, and every such scanner
 * loses to quoting, flow collections, block scalars and comments: a look-alike token inside a
 * quoted key swallows the quote a real alias needs as its context (so real aliases go unseen), and
 * tokens inside comments and block scalars look real (so a harmless file is refused). The engine
 * already knows which nodes are aliases, so it is asked: js-yaml calls a `listener` for every node
 * it composes, and an alias is the node whose result was looked up instead of read.
 *
 * Why one: with at most one alias a block expands to at most about twice its size, whatever the
 * anchor holds, and no cycle can multiply. The second alias is where a tree can start to grow
 * (two aliases of one anchor, or an anchor that contains an alias of itself and another of
 * something else), so it is where the parse stops. Anchors need no count of their own: an alias of
 * a name no anchor declares is a YAML error, and an anchor without a second alias is inert.
 *
 * An alias of nothing (null or an empty string) is not counted: it holds no value to repeat.
 */

export const MAX_ALIAS_NODES = 1;

/** The engine resolved more alias nodes than the guard allows; the parse was stopped. */
export class AliasLimitError extends Error {
  readonly aliases: number;

  constructor(aliases: number) {
    super(`frontmatter holds ${aliases} aliases, more than the ${MAX_ALIAS_NODES} allowed`);
    this.name = 'AliasLimitError';
    this.aliases = aliases;
  }
}

/** The fields of js-yaml's loader state this module reads when a node is complete. */
export interface YamlNodeState {
  readonly kind: string | null;
  readonly tag: string | null;
  readonly result: unknown;
  /** Offset in the block just after the node (and the separation space that follows it). */
  readonly position: number;
}

export type YamlListener = (event: 'open' | 'close', state: YamlNodeState) => void;

export interface AliasMeter {
  /** Pass to the YAML engine as its `listener` option. */
  readonly listener: YamlListener;
  /**
   * Call with what the engine returned. Throws when it returned a value without reporting a single
   * node: a meter nobody feeds guards nothing, so the parse must not count as checked.
   */
  readonly requireObserved: (parsed: unknown) => void;
}

/**
 * True for a node js-yaml composed by looking an anchor up. `composeNode` resets `kind` and `tag`
 * to null before it reads a node; scalars, sequences and mappings set `kind` while they are read
 * (a plain scalar also sets the tag), and an alias sets neither (a tag or anchor on an alias is a
 * YAML error). What is left with a null kind and tag is an empty node (null result) or an alias.
 */
function isAliasWithValue(state: YamlNodeState): boolean {
  if (state.kind !== null || state.tag !== null) return false;
  return state.result !== null && state.result !== undefined && state.result !== '';
}

export function createAliasMeter(): AliasMeter {
  let nodes = 0;
  // js-yaml reads a block entry that starts with an alias twice: first as the key of a mapping it
  // might be the start of, then, when no colon follows, as a plain node, and the listener hears
  // both. The two readings end at the same offset, so aliases are told apart by where they end.
  const aliasEnds = new Set<number>();
  return {
    listener: (event, state) => {
      if (event !== 'close') return;
      nodes += 1;
      if (!isAliasWithValue(state)) return;
      aliasEnds.add(state.position);
      if (aliasEnds.size > MAX_ALIAS_NODES) throw new AliasLimitError(aliasEnds.size);
    },
    requireObserved: (parsed) => {
      if (nodes === 0 && parsed !== undefined && parsed !== null) {
        throw new Error(
          'the YAML engine did not report its nodes, so its aliases cannot be counted',
        );
      }
    },
  };
}
