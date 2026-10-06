import { join } from 'node:path';
import { Command } from 'commander';
import chalk from 'chalk';
import { detectStaleness, scoreEntries } from '@commandvault/core';
import { loadConfig } from '../config.js';
import {
  claudeDirFor,
  createVaultInstance,
  jsonOutput,
  type CliGlobalOptions,
} from '../helpers.js';
import { CommandError, usageError } from '../errors.js';

const MAX_THRESHOLD_DAYS = 36_500;
const MAX_SCORE = 100;

/** A whole number from `min` to `max`; anything else (NaN, 1.5, "30days", -1) is a usage error. */
function parseWholeNumber(flag: string, raw: string, min: number, max: number): number {
  const value = /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : Number.NaN;
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw usageError(`${flag} must be a whole number between ${min} and ${max}`);
  }
  return value;
}

/** The gate: only an explicit --fail-under turns low-quality entries into exit 1. */
function failUnder(enabled: boolean, belowCount: number, minScore: number): void {
  if (enabled && belowCount > 0) {
    throw new CommandError(
      `${belowCount} ${belowCount === 1 ? 'entry' : 'entries'} scored below ${minScore}`,
    );
  }
}

export function createAuditCommand(): Command {
  const cmd = new Command('audit')
    .description('Detect stale entries and score vault quality')
    .option('--threshold <days>', 'Staleness threshold in days', '30')
    .option('--min-score <score>', 'Minimum quality score threshold', '40')
    .option('--fail-under', 'Exit 1 when any entry scores below --min-score')
    .action(async (opts, command) => {
      const globalOpts = command.optsWithGlobals() as CliGlobalOptions;
      const thresholdDays = parseWholeNumber('--threshold', opts.threshold, 0, MAX_THRESHOLD_DAYS);
      const minScore = parseWholeNumber('--min-score', opts.minScore, 0, MAX_SCORE);

      const config = await loadConfig();
      const settingsPath = join(claudeDirFor(globalOpts, config), 'settings.json');
      const vault = await createVaultInstance(globalOpts, { config });

      try {
        const entries = vault.getAllEntries();
        const [stalenessResults, qualityScores] = await Promise.all([
          detectStaleness(entries, thresholdDays, { settingsPath }),
          Promise.resolve(scoreEntries(entries)),
        ]);

        const staleEntries = stalenessResults.filter((r) => r.isStale);
        const missingEntries = stalenessResults.filter((r) => !r.sourceFileExists);
        const lowQuality = qualityScores.filter((q) => q.score < minScore);
        const avgScore =
          entries.length > 0
            ? Math.round(qualityScores.reduce((sum, q) => sum + q.score, 0) / entries.length)
            : 0;

        if (globalOpts.json) {
          jsonOutput({
            totalEntries: entries.length,
            stale: staleEntries.map((r) => ({
              name: r.entry.name,
              daysSinceModified: r.daysSinceModified,
              filePath: r.entry.filePath,
              sourceFileExists: r.sourceFileExists,
            })),
            missing: missingEntries.map((r) => ({
              name: r.entry.name,
              filePath: r.entry.filePath,
            })),
            lowQuality: lowQuality.map((q) => ({
              name: q.entry.name,
              score: q.score,
              breakdown: q.breakdown,
              filePath: q.entry.filePath,
            })),
            summary: {
              staleCount: staleEntries.length,
              missingCount: missingEntries.length,
              lowQualityCount: lowQuality.length,
              averageScore: avgScore,
            },
          });
          failUnder(opts.failUnder === true, lowQuality.length, minScore);
          return;
        }

        console.log('');
        console.log(chalk.bold.white('  === Vault Audit Report ==='));
        console.log('');

        // Stale entries section
        console.log(chalk.bold.white(`  Stale Entries (not modified in ${thresholdDays}+ days):`));

        const staleOnly = staleEntries.filter((r) => r.sourceFileExists);
        if (staleOnly.length === 0 && missingEntries.length === 0) {
          console.log(chalk.dim('    No stale entries found.'));
        } else {
          for (const result of staleOnly.slice(0, 20)) {
            const days =
              result.daysSinceModified === Infinity ? '?' : String(result.daysSinceModified);
            console.log(
              `    ${chalk.yellow('⚠')} ${chalk.white(result.entry.name)} ${chalk.dim(`(${days} days)`)} ${chalk.dim('—')} ${chalk.dim(result.entry.filePath)}`,
            );
          }
          for (const result of missingEntries.slice(0, 10)) {
            console.log(
              `    ${chalk.red('✗')} ${chalk.red(result.entry.name)} ${chalk.dim('— source file no longer exists')}`,
            );
          }
        }

        console.log('');

        // Low quality section
        console.log(chalk.bold.white(`  Low Quality Entries (score < ${minScore}):`));

        if (lowQuality.length === 0) {
          console.log(chalk.dim('    No low-quality entries found.'));
        } else {
          for (const q of lowQuality.slice(0, 20)) {
            const reasons: string[] = [];
            if (q.breakdown.completeness < 8) reasons.push('minimal content');
            if (q.breakdown.recency === 0) reasons.push('very old');
            if (q.breakdown.usage === 0 && q.breakdown.engagement === 0) reasons.push('never used');
            const reasonStr = reasons.length > 0 ? ` — ${reasons.join(', ')}` : '';
            console.log(
              `    ${chalk.dim('●')} ${chalk.white(q.entry.name)} ${chalk.dim(`(score: ${q.score})`)}${chalk.dim(reasonStr)}`,
            );
          }
        }

        console.log('');

        // Summary
        console.log(chalk.bold.white('  Summary:'));
        console.log(`    Total entries: ${chalk.bold(String(entries.length))}`);
        const stalePct =
          entries.length > 0 ? ((staleEntries.length / entries.length) * 100).toFixed(1) : '0';
        console.log(`    Stale: ${chalk.yellow(String(staleEntries.length))} (${stalePct}%)`);
        console.log(`    Missing source: ${chalk.red(String(missingEntries.length))}`);
        const lowPct =
          entries.length > 0 ? ((lowQuality.length / entries.length) * 100).toFixed(1) : '0';
        console.log(`    Low quality: ${chalk.yellow(String(lowQuality.length))} (${lowPct}%)`);
        console.log(`    Average quality score: ${chalk.bold(`${avgScore}/100`)}`);
        console.log('');
        failUnder(opts.failUnder === true, lowQuality.length, minScore);
      } finally {
        await vault.dispose();
      }
    });

  return cmd;
}
