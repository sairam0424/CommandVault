import React from 'react';
import { render } from 'ink-testing-library';
import { describe, it, expect } from 'vitest';
import type { SearchResult, VaultEntry } from '@commandvault/core';
import { ResultsList } from '../../tui/ResultsList.js';

function makeResult(
  name: string,
  description = 'desc',
  overrides: Partial<VaultEntry> = {},
): SearchResult {
  return {
    entry: {
      id: `${overrides.type ?? 'skill'}:${overrides.source ?? 'custom'}:${name}`,
      name,
      type: 'skill',
      source: 'custom',
      description,
      filePath: '/f',
      tags: [],
      metadata: {},
      content: '',
      lastModified: new Date(),
      favorite: false,
      usageCount: 0,
      ...overrides,
    } as VaultEntry,
    score: 1,
    matchedFields: [],
  };
}

const SOLO_WIDTH = 60;
const NARROWEST_LIST_WIDTH = 28;

function frameOf(rows: SearchResult[], options: { selectedIndex?: number; width?: number } = {}) {
  const { lastFrame } = render(
    <ResultsList
      results={rows}
      selectedIndex={options.selectedIndex ?? 0}
      scrollTop={0}
      visibleCount={rows.length}
      width={options.width ?? SOLO_WIDTH}
    />,
  );
  return (lastFrame() ?? '').split('\n');
}

const results = [
  makeResult('alpha', 'Alpha description'),
  makeResult('beta', 'Beta description'),
  makeResult('gamma', 'Gamma description'),
  makeResult('delta', 'Delta description'),
  makeResult('epsilon', 'Epsilon description'),
  makeResult('zeta', 'Zeta description'),
  makeResult('eta', 'Eta description'),
];

describe('ResultsList', () => {
  it('renders correct window: scrollTop=0, visibleCount=3 shows rows 0,1,2 and not row 3', () => {
    const { lastFrame } = render(
      <ResultsList results={results} selectedIndex={0} scrollTop={0} visibleCount={3} width={60} />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('alpha');
    expect(frame).toContain('beta');
    expect(frame).toContain('gamma');
    expect(frame).not.toContain('delta');
  });

  it('renders from scrollTop offset: scrollTop=4, visibleCount=3 shows rows 4,5,6 and not row 0', () => {
    const { lastFrame } = render(
      <ResultsList results={results} selectedIndex={4} scrollTop={4} visibleCount={3} width={60} />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('epsilon');
    expect(frame).toContain('zeta');
    expect(frame).toContain('eta');
    expect(frame).not.toContain('alpha');
  });

  it('shows empty state message when results is empty array', () => {
    const { lastFrame } = render(
      <ResultsList results={[]} selectedIndex={0} scrollTop={0} visibleCount={5} width={60} />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('No matches');
  });

  it('active row marker: selected row contains ▶', () => {
    const { lastFrame } = render(
      <ResultsList results={results} selectedIndex={1} scrollTop={0} visibleCount={3} width={60} />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('▶');
  });

  describe('row content', () => {
    it('shows the type and the source of every entry', () => {
      const lines = frameOf([
        makeResult('browse', 'Fast browser', { type: 'skill', source: 'gstack' }),
      ]);

      expect(lines[0]).toContain('browse');
      expect(lines[1]).toContain('[skill · gstack]');
      expect(lines[1]).toContain('Fast browser');
    });

    it('tells apart entries that share a name', () => {
      const lines = frameOf([
        makeResult('deploy', 'Ship it', { type: 'skill', source: 'custom' }),
        makeResult('deploy', 'Ship it', { type: 'command', source: 'gstack' }),
      ]);

      const tags = lines.filter((l) => l.includes('['));
      expect(tags).toHaveLength(2);
      expect(tags[0]).not.toEqual(tags[1]);
      expect(tags[0]).toContain('[skill · custom]');
      expect(tags[1]).toContain('[command · gstack]');
    });

    it('marks a favorite with a star and leaves other rows without one', () => {
      const lines = frameOf([
        makeResult('loved', 'desc', { favorite: true }),
        makeResult('plain', 'desc', { favorite: false }),
      ]);

      expect(lines[0]).toContain('★');
      expect(lines.join('\n').match(/★/g)).toHaveLength(1);
    });

    it('puts the star between the selection marker and the name', () => {
      const lines = frameOf([makeResult('loved', 'desc', { favorite: true })]);

      expect(lines[0]).toContain('▶ ★ loved');
    });

    it('shows the usage count only when the entry was used', () => {
      const lines = frameOf([
        makeResult('used', 'desc', { usageCount: 7 }),
        makeResult('fresh', 'desc', { usageCount: 0 }),
      ]);

      expect(lines.find((l) => l.includes('used'))).toContain('×7');
      expect(lines.find((l) => l.includes('fresh'))).not.toContain('×');
    });

    it('cuts a long name before the usage count and never wraps a row', () => {
      const lines = frameOf(
        [makeResult('n'.repeat(80), 'd'.repeat(80), { usageCount: 12, favorite: true })],
        { width: NARROWEST_LIST_WIDTH },
      );

      expect(lines).toHaveLength(2);
      expect(lines[0]).toContain('…');
      expect(lines[0]).toContain('×12');
      for (const line of lines) expect(line.length).toBeLessThanOrEqual(NARROWEST_LIST_WIDTH);
    });

    it('keeps the type and source visible at the narrowest list width', () => {
      const lines = frameOf(
        [makeResult('x', 'd'.repeat(80), { type: 'command', source: 'superpowers' })],
        { width: NARROWEST_LIST_WIDTH },
      );

      expect(lines[1]).toContain('[command · superpowers]');
    });

    it('draws a description that holds a line break on one row', () => {
      const lines = frameOf([makeResult('multi', 'first line\nsecond line')]);

      expect(lines).toHaveLength(2);
    });

    it('does not advertise a filter key in the empty state', () => {
      const { lastFrame } = render(
        <ResultsList results={[]} selectedIndex={0} scrollTop={0} visibleCount={5} width={60} />,
      );

      expect(lastFrame()).not.toContain('Tab');
    });
  });
});
