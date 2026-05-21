import { Command } from 'commander';
import chalk from 'chalk';
import { detectStaleness, scoreEntries } from '@commandvault/core';
import { createVaultInstance, jsonOutput, type CliGlobalOptions } from '../helpers.js';

export function createAuditCommand(): Command {
  const cmd = new Command('audit')
    .description('Detect stale entries and score vault quality')
    .option('--threshold <days>', 'Staleness threshold in days', '30')
    .option('--min-score <score>', 'Minimum quality score threshold', '40')
    .action(async (opts, command) => {
      const globalOpts = command.optsWithGlobals() as CliGlobalOptions;
      const thresholdDays = parseInt(opts.threshold, 10);
      const minScore = parseInt(opts.minScore, 10);

      const vault = await createVaultInstance(globalOpts);

      try {
        const entries = vault.getAllEntries();
        const [stalenessResults, qualityScores] = await Promise.all([
          detectStaleness(entries, thresholdDays),
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
      } finally {
        await vault.dispose();
      }
    });

  return cmd;
}
