import React from 'react';
import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import type { VaultEntry } from '@commandvault/core';
import { PreviewPane } from '../../tui/PreviewPane.js';
import { previewTextRows } from '../../tui/previewExcerpt.js';

function makeEntry(overrides: Partial<VaultEntry> = {}): VaultEntry {
  return {
    id: 'x',
    name: 'test',
    type: 'skill',
    source: 'custom',
    description: 'A skill',
    filePath: '/fake',
    tags: ['testing'],
    metadata: {},
    content: 'Line one\nLine two FINDME\nLine three',
    lastModified: new Date('2026-01-01'),
    favorite: false,
    usageCount: 3,
    ...overrides,
  };
}

// The sweep over pane heights renders dozens of frames; a loaded machine needs more than 5 s.
const SWEEP_TIMEOUT_MS = 30_000;

describe('PreviewPane', () => {
  it('shows "Select a result to preview" when entry is null', () => {
    const { lastFrame } = render(
      <PreviewPane entry={null} query="" scrollTop={0} height={10} width={40} />,
    );
    expect(lastFrame()).toContain('Select a result to preview');
  });

  it('shows metadata (type + source) when content is empty string', () => {
    const entry = makeEntry({ content: '' });
    const { lastFrame } = render(
      <PreviewPane entry={entry} query="" scrollTop={0} height={10} width={40} />,
    );
    const output = lastFrame() ?? '';
    expect(output).toContain('Type');
    expect(output).toContain('skill');
    expect(output).toContain('Source');
    expect(output).toContain('custom');
  });

  it('renders excerpt content when content is non-empty', () => {
    const entry = makeEntry({
      content: 'Line one\nLine two FINDME\nLine three',
    });
    const { lastFrame } = render(
      <PreviewPane entry={entry} query="FINDME" scrollTop={0} height={10} width={40} />,
    );
    const output = lastFrame() ?? '';
    expect(output).toContain('Line one');
    expect(output).toContain('Line two FINDME');
    expect(output).toContain('Line three');
  });

  it('respects scrollTop: scrollTop=10 shows row 10 and not row 0', () => {
    // Build 20-line content: "row 0", "row 1", ..., "row 19"
    const lines = Array.from({ length: 20 }, (_, i) => `row ${i}`);
    const content = lines.join('\n');
    const entry = makeEntry({ content });

    // height=15 → maxLines passed to getContentExcerpt = 30, so all 20 lines
    // are returned. scrollTop=10 + height=5 visible window shows rows 10–14.
    const { lastFrame } = render(
      <PreviewPane entry={entry} query="" scrollTop={10} height={15} width={40} />,
    );
    const output = lastFrame() ?? '';
    expect(output).toContain('row 10');
    expect(output).not.toContain('row 0');
  });

  describe('what the pane shows of the content', () => {
    const rowsOf = (n: number) => Array.from({ length: n }, (_, i) => `row ${i}`);
    const draw = (content: string, scrollTop: number, height: number, width = 40) => {
      const { lastFrame } = render(
        <PreviewPane
          entry={makeEntry({ content })}
          query=""
          scrollTop={scrollTop}
          height={height}
          width={width}
        />,
      );
      return (lastFrame() ?? '').split('\n');
    };

    it(
      'shows every line of an entry that fits, the last one included, at every pane height',
      { timeout: SWEEP_TIMEOUT_MS },
      () => {
        for (let height = 8; height <= 40; height += 1) {
          const textRows = previewTextRows(height);
          const lines = draw(rowsOf(textRows).join('\n'), 0, height);

          expect(lines, `pane height ${height}`).toHaveLength(height);
          for (let row = 0; row < textRows; row += 1) {
            expect(lines.join('\n'), `pane height ${height}, line ${row}`).toMatch(
              new RegExp(`row ${row}\\b`),
            );
          }
        }
      },
    );

    it('shows the last line when scrolled to the end of a long entry', () => {
      const lines = draw(rowsOf(100).join('\n'), 10_000, 12);

      expect(lines.join('\n')).toContain('row 99');
      expect(lines.join('\n')).not.toContain('row 0');
    });

    it('reaches lines far past twice the pane height', () => {
      const height = 10;
      const lines = draw(rowsOf(300).join('\n'), 250, height);

      expect(lines.join('\n')).toContain('row 250');
      expect(lines.join('\n')).toContain(`row ${250 + previewTextRows(height) - 1}`);
    });

    it('keeps a long line on one row so the lines after it stay in view', () => {
      const content = ['first', 'x'.repeat(400), 'third', 'fourth'].join('\n');

      const lines = draw(content, 0, 10);
      const at = lines.findIndex((line) => line.includes('first'));

      expect(lines).toHaveLength(10);
      expect(lines[at + 1]).toMatch(/x{10}/);
      expect(lines[at + 2]).toContain('third');
      expect(lines[at + 3]).toContain('fourth');
    });

    it('keeps blank lines, so the rows drawn match the lines paged through', () => {
      const lines = draw('above\n\n\nbelow', 0, 10);
      const at = lines.findIndex((line) => line.includes('above'));

      expect(lines[at + 3]).toContain('below');
    });

    it('draws tabs and control characters without breaking the rows', () => {
      const content = 'a\tb\u001b[31mred\u0007\nsecond\r\nthird';

      const lines = draw(content, 0, 10);

      expect(lines).toHaveLength(10);
      expect(lines.join('\n')).not.toContain('\u001b');
      expect(lines.join('\n')).toContain('second');
      expect(lines.join('\n')).toContain('third');
    });

    it('names the type, source and file of the entry above its text', () => {
      const lines = draw('body', 0, 10, 60);

      expect(lines[1]).toContain('[skill · custom]');
      expect(lines[1]).toContain('/fake');
      expect(lines[2]).toContain('body');
    });

    it('keeps the end of a long file path, the part that tells files apart', () => {
      const { lastFrame } = render(
        <PreviewPane
          entry={makeEntry({ filePath: `/${'deep/'.repeat(30)}SKILL.md`, content: 'body' })}
          query=""
          scrollTop={0}
          height={10}
          width={50}
        />,
      );

      expect(lastFrame()).toContain('SKILL.md');
    });

    it('shows a metadata fallback that fits the pane for an entry with no content', () => {
      const lines = draw('', 0, 10, 40);
      expect(lines).toHaveLength(10);

      const { lastFrame } = render(
        <PreviewPane
          entry={makeEntry({ content: '', filePath: `/${'long/'.repeat(30)}x.md` })}
          query=""
          scrollTop={0}
          height={10}
          width={40}
        />,
      );
      expect((lastFrame() ?? '').split('\n')).toHaveLength(10);
    });
  });
});
