import React from 'react';
import { render } from 'ink-testing-library';
import { describe, it, expect } from 'vitest';
import type { SearchResult, VaultEntry } from '@commandvault/core';
import { ResultsList } from '../../tui/ResultsList.js';

function makeResult(name: string, description = 'desc'): SearchResult {
  return {
    entry: {
      id: name,
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
    } as VaultEntry,
    score: 1,
    matchedFields: [],
  };
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
      <ResultsList
        results={results}
        selectedIndex={0}
        scrollTop={0}
        visibleCount={3}
        width={60}
      />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('alpha');
    expect(frame).toContain('beta');
    expect(frame).toContain('gamma');
    expect(frame).not.toContain('delta');
  });

  it('renders from scrollTop offset: scrollTop=4, visibleCount=3 shows rows 4,5,6 and not row 0', () => {
    const { lastFrame } = render(
      <ResultsList
        results={results}
        selectedIndex={4}
        scrollTop={4}
        visibleCount={3}
        width={60}
      />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('epsilon');
    expect(frame).toContain('zeta');
    expect(frame).toContain('eta');
    expect(frame).not.toContain('alpha');
  });

  it('shows empty state message when results is empty array', () => {
    const { lastFrame } = render(
      <ResultsList
        results={[]}
        selectedIndex={0}
        scrollTop={0}
        visibleCount={5}
        width={60}
      />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('No matches');
  });

  it('active row marker: selected row contains ▶', () => {
    const { lastFrame } = render(
      <ResultsList
        results={results}
        selectedIndex={1}
        scrollTop={0}
        visibleCount={3}
        width={60}
      />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('▶');
  });
});
