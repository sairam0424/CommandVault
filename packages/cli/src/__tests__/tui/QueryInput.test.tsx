import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { Box } from 'ink';
import { render, cleanup } from 'ink-testing-library';
import { QueryInput } from '../../tui/QueryInput.js';

const BOX_COLUMNS = 20;

describe('QueryInput', () => {
  afterEach(() => {
    cleanup();
  });

  // The window is sized by a width table; this is the net under it, so a character the table
  // counts too narrow is cut by Ink instead of wrapping the search box onto a second row.
  it('stays on one row when it is given more room than the box has', () => {
    const { lastFrame } = render(
      <Box width={BOX_COLUMNS}>
        <QueryInput value={'a'.repeat(60)} cursor={60} placeholder="Search" capacity={60} />
      </Box>,
    );

    expect((lastFrame() ?? '').split('\n')).toHaveLength(1);
  });

  it('draws the placeholder on one row when the query is empty', () => {
    const { lastFrame } = render(
      <Box width={BOX_COLUMNS}>
        <QueryInput value="" cursor={0} placeholder="Search commands..." capacity={BOX_COLUMNS} />
      </Box>,
    );

    expect(lastFrame()).toContain('Search commands');
  });
});
