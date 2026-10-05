import { useEffect, useState } from 'react';
import { useStdout } from 'ink';

const DEFAULT_COLUMNS = 100;
const DEFAULT_ROWS = 30;

export interface TerminalSize {
  readonly columns: number;
  readonly rows: number;
}

function readSize(stdout: NodeJS.WriteStream | undefined): TerminalSize {
  return {
    columns: stdout?.columns || DEFAULT_COLUMNS,
    rows: stdout?.rows || DEFAULT_ROWS,
  };
}

/**
 * The terminal size, refreshed when the window is resized. `useStdout` alone
 * hands back the stream once and never re-renders, so the layout went stale.
 */
export function useTerminalSize(): TerminalSize {
  const { stdout } = useStdout();
  const [size, setSize] = useState<TerminalSize>(() => readSize(stdout));

  useEffect(() => {
    if (!stdout) return;
    const onResize = () => setSize(readSize(stdout));
    stdout.on('resize', onResize);
    return () => {
      stdout.off('resize', onResize);
    };
  }, [stdout]);

  return size;
}
