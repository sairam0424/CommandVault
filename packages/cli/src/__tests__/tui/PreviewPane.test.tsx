import React from 'react';
import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import type { VaultEntry } from '@commandvault/core';
import { PreviewPane } from '../../tui/PreviewPane.js';

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

describe('PreviewPane', () => {
  it('shows "Select a result to preview" when entry is null', () => {
    const { lastFrame } = render(
      <PreviewPane
        entry={null}
        query=""
        scrollTop={0}
        height={10}
        width={40}
      />,
    );
    expect(lastFrame()).toContain('Select a result to preview');
  });

  it('shows metadata (type + source) when content is empty string', () => {
    const entry = makeEntry({ content: '' });
    const { lastFrame } = render(
      <PreviewPane
        entry={entry}
        query=""
        scrollTop={0}
        height={10}
        width={40}
      />,
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
      <PreviewPane
        entry={entry}
        query="FINDME"
        scrollTop={0}
        height={10}
        width={40}
      />,
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
      <PreviewPane
        entry={entry}
        query=""
        scrollTop={10}
        height={15}
        width={40}
      />,
    );
    const output = lastFrame() ?? '';
    expect(output).toContain('row 10');
    expect(output).not.toContain('row 0');
  });
});
