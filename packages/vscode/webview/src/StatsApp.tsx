import { useState, useEffect, useCallback, useRef } from 'react';

interface VaultStats {
  readonly totalEntries: number;
  readonly byType: Readonly<Record<string, number>>;
  readonly bySource: Readonly<Record<string, number>>;
  readonly favoriteCount: number;
  readonly lastScanAt: string;
}

interface TopEntry {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly usageCount: number;
}

interface InitMessage {
  readonly type: 'init';
  readonly data: {
    readonly stats: VaultStats;
    readonly topUsed: readonly TopEntry[];
  };
}

interface StatsMessage {
  readonly type: 'stats';
  readonly data: VaultStats;
}

interface TopUsedMessage {
  readonly type: 'topUsed';
  readonly data: readonly TopEntry[];
}

type IncomingMessage = InitMessage | StatsMessage | TopUsedMessage;

const TYPE_COLORS: Readonly<Record<string, string>> = {
  skill: '#00bcd4',
  agent: '#2196f3',
  command: '#ffca28',
  plugin: '#4caf50',
  rule: '#e040fb',
  hook: '#ef5350',
};

const vscodeApi = acquireVsCodeApi();

function BarChart({
  data,
  colorMap,
  onBarClick,
}: {
  readonly data: Readonly<Record<string, number>>;
  readonly colorMap?: Readonly<Record<string, string>>;
  readonly onBarClick?: (label: string) => void;
}) {
  const entries = Object.entries(data).filter(([, count]) => count > 0);
  if (entries.length === 0) {
    return <p style={styles.muted}>No data</p>;
  }

  const maxCount = Math.max(...entries.map(([, count]) => count));

  return (
    <div style={styles.barChartContainer}>
      {entries.map(([label, count]) => {
        const percentage = maxCount > 0 ? (count / maxCount) * 100 : 0;
        const barColor =
          colorMap?.[label] ?? 'var(--vscode-progressBar-background)';
        const isClickable = !!onBarClick;

        return (
          <div
            key={label}
            style={{
              ...styles.barRow,
              ...(isClickable ? styles.clickableRow : {}),
            }}
            onClick={isClickable ? () => onBarClick(label) : undefined}
            role={isClickable ? 'button' : undefined}
            tabIndex={isClickable ? 0 : undefined}
            onKeyDown={
              isClickable
                ? (e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      onBarClick(label);
                    }
                  }
                : undefined
            }
          >
            <span style={styles.barLabel}>{label}</span>
            <div style={styles.barTrack}>
              <div
                style={{
                  ...styles.barFill,
                  width: `${percentage}%`,
                  backgroundColor: barColor,
                }}
              />
            </div>
            <span style={styles.barCount}>{count}</span>
          </div>
        );
      })}
    </div>
  );
}

function TopUsedList({
  entries,
  onEntryClick,
}: {
  readonly entries: readonly TopEntry[];
  readonly onEntryClick?: (id: string) => void;
}) {
  if (entries.length === 0) {
    return <p style={styles.muted}>No usage data yet</p>;
  }

  return (
    <div style={styles.topList}>
      {entries.map((entry, index) => (
        <div key={entry.id ?? entry.name} style={styles.topListItem}>
          <span style={styles.topListRank}>#{index + 1}</span>
          <span
            style={{
              ...styles.topListName,
              ...(onEntryClick ? styles.clickableName : {}),
            }}
            onClick={onEntryClick && entry.id ? () => onEntryClick(entry.id) : undefined}
            role={onEntryClick && entry.id ? 'button' : undefined}
            tabIndex={onEntryClick && entry.id ? 0 : undefined}
            onKeyDown={
              onEntryClick && entry.id
                ? (e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      onEntryClick(entry.id);
                    }
                  }
                : undefined
            }
          >
            {entry.name}
          </span>
          <span
            style={{
              ...styles.topListBadge,
              backgroundColor:
                TYPE_COLORS[entry.type] ?? 'var(--vscode-badge-background)',
            }}
          >
            {entry.type}
          </span>
          <span style={styles.topListCount}>
            {entry.usageCount} use{entry.usageCount !== 1 ? 's' : ''}
          </span>
        </div>
      ))}
    </div>
  );
}

const AUTO_REFRESH_INTERVAL_MS = 30_000;

function formatSecondsAgo(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s ago`;
}

export function StatsApp() {
  const [stats, setStats] = useState<VaultStats | null>(null);
  const [topUsed, setTopUsed] = useState<readonly TopEntry[]>([]);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number>(Date.now());
  const [timeSinceUpdate, setTimeSinceUpdate] = useState<string>('just now');
  const autoRefreshRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const tickRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  const handleMessage = useCallback((event: MessageEvent) => {
    const message = event.data as IncomingMessage;
    if (message.type === 'init') {
      setStats(message.data.stats);
      setTopUsed(message.data.topUsed);
      setLastUpdatedAt(Date.now());
    } else if (message.type === 'stats') {
      setStats(message.data);
      setLastUpdatedAt(Date.now());
    } else if (message.type === 'topUsed') {
      setTopUsed(message.data);
      setLastUpdatedAt(Date.now());
    }
  }, []);

  const handleRefresh = useCallback(() => {
    vscodeApi.postMessage({ type: 'refresh' });
  }, []);

  const handleTypeBarClick = useCallback((typeName: string) => {
    vscodeApi.postMessage({ type: 'filterByType', data: typeName });
  }, []);

  const handleEntryClick = useCallback((entryId: string) => {
    vscodeApi.postMessage({ type: 'openDetail', data: entryId });
  }, []);

  useEffect(() => {
    window.addEventListener('message', handleMessage);
    vscodeApi.postMessage({ type: 'ready' });
    return () => {
      window.removeEventListener('message', handleMessage);
    };
  }, [handleMessage]);

  useEffect(() => {
    autoRefreshRef.current = setInterval(() => {
      vscodeApi.postMessage({ type: 'refresh' });
    }, AUTO_REFRESH_INTERVAL_MS);

    tickRef.current = setInterval(() => {
      setTimeSinceUpdate(formatSecondsAgo(Date.now() - lastUpdatedAt));
    }, 1000);

    return () => {
      if (autoRefreshRef.current !== undefined) clearInterval(autoRefreshRef.current);
      if (tickRef.current !== undefined) clearInterval(tickRef.current);
    };
  }, [lastUpdatedAt]);

  if (!stats) {
    return (
      <div style={styles.container}>
        <p style={styles.muted}>Loading stats...</p>
      </div>
    );
  }

  const formattedDate = stats.lastScanAt
    ? new Date(stats.lastScanAt).toLocaleString()
    : 'Never';

  return (
    <div style={styles.container}>
      <header style={styles.header}>
        <div style={styles.titleRow}>
          <h1 style={styles.title}>CommandVault Dashboard</h1>
          <div style={styles.refreshArea}>
            <span style={styles.lastUpdated}>Updated: {timeSinceUpdate}</span>
            <button
              style={styles.refreshButton}
              onClick={handleRefresh}
              title="Refresh stats"
              type="button"
            >
              Refresh
            </button>
          </div>
        </div>
        <div style={styles.headerStats}>
          <div style={styles.statCard}>
            <span style={styles.statValue}>{stats.totalEntries}</span>
            <span style={styles.statLabel}>Total Entries</span>
          </div>
          <div style={styles.statCard}>
            <span style={styles.statValue}>{stats.favoriteCount}</span>
            <span style={styles.statLabel}>Favorites</span>
          </div>
          <div style={styles.statCard}>
            <span style={styles.statValueSmall}>{formattedDate}</span>
            <span style={styles.statLabel}>Last Scan</span>
          </div>
        </div>
      </header>

      <section style={styles.section}>
        <h2 style={styles.sectionTitle}>By Type</h2>
        <BarChart data={stats.byType} colorMap={TYPE_COLORS} onBarClick={handleTypeBarClick} />
      </section>

      <section style={styles.section}>
        <h2 style={styles.sectionTitle}>By Source</h2>
        <BarChart data={stats.bySource} />
      </section>

      <section style={styles.section}>
        <h2 style={styles.sectionTitle}>Top Used</h2>
        <TopUsedList entries={topUsed} onEntryClick={handleEntryClick} />
      </section>
    </div>
  );
}

const styles: Readonly<Record<string, React.CSSProperties>> = {
  container: {
    fontFamily: 'var(--vscode-font-family)',
    fontSize: 'var(--vscode-font-size)',
    color: 'var(--vscode-foreground)',
    backgroundColor: 'var(--vscode-editor-background)',
    padding: '24px',
    lineHeight: 1.6,
    maxWidth: '800px',
  },
  header: {
    marginBottom: '24px',
    paddingBottom: '16px',
    borderBottom: '1px solid var(--vscode-widget-border)',
  },
  titleRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: '16px',
    gap: '12px',
    flexWrap: 'wrap' as const,
  },
  title: {
    fontSize: '1.6em',
    fontWeight: 600,
    color: 'var(--vscode-foreground)',
    margin: 0,
  },
  refreshArea: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    flexShrink: 0,
  },
  lastUpdated: {
    fontSize: '0.8em',
    color: 'var(--vscode-descriptionForeground)',
  },
  refreshButton: {
    padding: '4px 12px',
    fontSize: '0.85em',
    fontWeight: 500,
    color: 'var(--vscode-button-foreground)',
    backgroundColor: 'var(--vscode-button-background)',
    border: 'none',
    borderRadius: '4px',
    cursor: 'pointer',
    lineHeight: 1.4,
  },
  clickableRow: {
    cursor: 'pointer',
    borderRadius: '4px',
    padding: '4px 6px',
    transition: 'background-color 0.15s ease',
  },
  clickableName: {
    cursor: 'pointer',
    textDecoration: 'underline',
    textDecorationColor: 'var(--vscode-textLink-foreground)',
    color: 'var(--vscode-textLink-foreground)',
  },
  headerStats: {
    display: 'flex',
    gap: '16px',
    flexWrap: 'wrap' as const,
  },
  statCard: {
    display: 'flex',
    flexDirection: 'column' as const,
    padding: '12px 20px',
    borderRadius: '6px',
    backgroundColor: 'var(--vscode-textBlockQuote-background)',
    border: '1px solid var(--vscode-widget-border)',
    minWidth: '120px',
  },
  statValue: {
    fontSize: '1.8em',
    fontWeight: 700,
    color: 'var(--vscode-foreground)',
    lineHeight: 1.2,
  },
  statValueSmall: {
    fontSize: '0.95em',
    fontWeight: 600,
    color: 'var(--vscode-foreground)',
    lineHeight: 1.4,
  },
  statLabel: {
    fontSize: '0.8em',
    color: 'var(--vscode-descriptionForeground)',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.05em',
    marginTop: '4px',
  },
  section: {
    marginBottom: '24px',
  },
  sectionTitle: {
    fontSize: '1.1em',
    fontWeight: 600,
    color: 'var(--vscode-foreground)',
    marginBottom: '12px',
    paddingBottom: '4px',
    borderBottom: '1px solid var(--vscode-widget-border)',
  },
  muted: {
    color: 'var(--vscode-disabledForeground)',
    fontStyle: 'italic' as const,
  },
  barChartContainer: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '8px',
  },
  barRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
  },
  barLabel: {
    width: '90px',
    fontSize: '0.9em',
    textAlign: 'right' as const,
    flexShrink: 0,
    color: 'var(--vscode-foreground)',
  },
  barTrack: {
    flex: 1,
    height: '20px',
    backgroundColor: 'var(--vscode-input-background)',
    borderRadius: '4px',
    overflow: 'hidden',
  },
  barFill: {
    height: '100%',
    borderRadius: '4px',
    transition: 'width 0.3s ease',
    minWidth: '2px',
  },
  barCount: {
    width: '40px',
    fontSize: '0.85em',
    fontWeight: 600,
    color: 'var(--vscode-badge-foreground)',
    backgroundColor: 'var(--vscode-badge-background)',
    borderRadius: '10px',
    textAlign: 'center' as const,
    padding: '1px 6px',
    flexShrink: 0,
  },
  topList: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '6px',
  },
  topListItem: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    padding: '6px 10px',
    borderRadius: '4px',
    backgroundColor: 'var(--vscode-list-hoverBackground)',
  },
  topListRank: {
    fontSize: '0.85em',
    fontWeight: 700,
    color: 'var(--vscode-descriptionForeground)',
    width: '28px',
    flexShrink: 0,
  },
  topListName: {
    flex: 1,
    fontSize: '0.9em',
    color: 'var(--vscode-foreground)',
    fontWeight: 500,
  },
  topListBadge: {
    fontSize: '0.7em',
    padding: '1px 8px',
    borderRadius: '10px',
    color: '#fff',
    textTransform: 'uppercase' as const,
    fontWeight: 600,
    letterSpacing: '0.03em',
    flexShrink: 0,
  },
  topListCount: {
    fontSize: '0.8em',
    color: 'var(--vscode-descriptionForeground)',
    flexShrink: 0,
  },
};
