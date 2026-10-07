import { describe, expect, it } from 'vitest';
import { BODY_BLOCK_BYTES, BodyCollector } from '../../net/body-collector.js';

/**
 * The collector replaces "keep every chunk" with "copy into fixed blocks". The risks are in the
 * seams: a chunk that straddles a block boundary, a body that ends exactly on one, a multi-byte
 * character cut by the boundary, and a byte order mark that must go only from the very start.
 */

const BOM = '\uFEFF';

function collect(chunks: readonly Buffer[]): BodyCollector {
  const collector = new BodyCollector();
  for (const chunk of chunks) collector.append(chunk);
  return collector;
}

/** `text` split into pieces of `size` BYTES (so a piece may cut a character in two). */
function splitBytes(text: string, size: number): Buffer[] {
  const bytes = Buffer.from(text, 'utf8');
  const pieces: Buffer[] = [];
  for (let offset = 0; offset < bytes.length; offset += size) {
    pieces.push(bytes.subarray(offset, offset + size));
  }
  return pieces;
}

describe('BodyCollector', () => {
  it('is empty before anything arrives', () => {
    const collector = new BodyCollector();
    expect(collector.length).toBe(0);
    expect(collector.text()).toBe('');
  });

  it('returns what it was given, however the body was chunked', () => {
    const text = JSON.stringify({ a: 'x'.repeat(3 * BODY_BLOCK_BYTES + 17), b: [1, 2, 3] });
    for (const size of [1, 7, 4096, BODY_BLOCK_BYTES - 1, BODY_BLOCK_BYTES, BODY_BLOCK_BYTES + 1]) {
      const collector = collect(splitBytes(text, size));
      expect(collector.length).toBe(Buffer.byteLength(text));
      expect(collector.text()).toBe(text);
    }
  });

  it('handles a body that ends exactly on a block boundary, and one byte either side', () => {
    for (const bytes of [BODY_BLOCK_BYTES - 1, BODY_BLOCK_BYTES, BODY_BLOCK_BYTES + 1]) {
      const text = 'y'.repeat(bytes);
      expect(collect(splitBytes(text, 1000)).text()).toBe(text);
      expect(collect([Buffer.from(text)]).text()).toBe(text);
    }
  });

  it('takes one chunk that spans several blocks', () => {
    const text = 'z'.repeat(5 * BODY_BLOCK_BYTES + 3);
    const collector = collect([Buffer.from(text)]);
    expect(collector.length).toBe(text.length);
    expect(collector.text()).toBe(text);
  });

  it('decodes a multi-byte character that a chunk or a block boundary cuts in two', () => {
    // 3-byte characters, placed so one straddles the first block boundary.
    const text = `${'a'.repeat(BODY_BLOCK_BYTES - 1)}€€€ done`;
    expect(collect(splitBytes(text, 1)).text()).toBe(text);
    expect(collect(splitBytes(text, 2)).text()).toBe(text);
    expect(collect([Buffer.from(text)]).text()).toBe(text);
  });

  it('ignores empty chunks', () => {
    const collector = collect([Buffer.alloc(0), Buffer.from('ab'), Buffer.alloc(0)]);
    expect(collector.length).toBe(2);
    expect(collector.text()).toBe('ab');
  });

  it('copies each chunk: changing the chunk afterwards changes nothing', () => {
    const chunk = Buffer.from('abcd');
    const collector = collect([chunk]);
    chunk.fill(0x7a);
    expect(collector.text()).toBe('abcd');
  });

  it('never shows bytes it was not given (blocks are not zeroed)', () => {
    const collector = collect([Buffer.from('end')]);
    expect(collector.text()).toBe('end');
    expect(collector.text()).toHaveLength(3);
  });

  describe('byte order mark', () => {
    it('drops one at the very start', () => {
      expect(collect([Buffer.from(`${BOM}{"a":1}`)]).text()).toBe('{"a":1}');
    });

    it('drops one that arrives a byte at a time', () => {
      expect(collect(splitBytes(`${BOM}{"a":1}`, 1)).text()).toBe('{"a":1}');
    });

    it('keeps one anywhere else', () => {
      expect(collect([Buffer.from(`{"a":"${BOM}"}`)]).text()).toBe(`{"a":"${BOM}"}`);
    });

    it('drops only the first of two', () => {
      expect(collect([Buffer.from(`${BOM}${BOM}x`)]).text()).toBe(`${BOM}x`);
    });
  });

  it('replaces invalid UTF-8 with U+FFFD instead of throwing', () => {
    const collector = collect([Buffer.from([0x61, 0xff, 0x62])]);
    expect(collector.text()).toBe('a\uFFFDb');
  });
});
