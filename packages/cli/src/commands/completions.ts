import { Command } from 'commander';
import chalk from 'chalk';

const SUBCOMMANDS = [
  'list',
  'search',
  'info',
  'stats',
  'export',
  'favorite',
  'init',
  'doctor',
  'import',
  'sync',
  'tag',
  'diff',
  'watch',
  'interactive',
  'open',
  'run',
  'backup',
  'restore',
  'config',
  'completions',
  'registry',
  'audit',
] as const;

function generateBash(): string {
  const cmds = SUBCOMMANDS.join(' ');
  return `# vault shell completions for bash
# Add to ~/.bashrc: eval "$(vault completions bash)"
_vault_completions() {
  local cur="\${COMP_WORDS[COMP_CWORD]}"
  local commands="${cmds}"

  if [ "\${COMP_CWORD}" -eq 1 ]; then
    COMPREPLY=( $(compgen -W "\${commands}" -- "\${cur}") )
    return 0
  fi

  case "\${COMP_WORDS[1]}" in
    list|ls)
      COMPREPLY=( $(compgen -W "--type --source --tag --favorites --json" -- "\${cur}") )
      ;;
    search|s)
      COMPREPLY=( $(compgen -W "--type --source --limit --json" -- "\${cur}") )
      ;;
    config)
      if [ "\${COMP_CWORD}" -eq 2 ]; then
        COMPREPLY=( $(compgen -W "get set" -- "\${cur}") )
      fi
      ;;
    completions)
      if [ "\${COMP_CWORD}" -eq 2 ]; then
        COMPREPLY=( $(compgen -W "bash zsh fish powershell" -- "\${cur}") )
      fi
      ;;
    *)
      COMPREPLY=( $(compgen -W "--json --claude-path --tier" -- "\${cur}") )
      ;;
  esac
  return 0
}
complete -F _vault_completions vault
`;
}

function generateZsh(): string {
  const cmdLines = SUBCOMMANDS.map((c) => `    '${c}:${c} command'`).join('\n');

  return `# vault shell completions for zsh
# Add to ~/.zshrc: eval "$(vault completions zsh)"
_vault() {
  local -a commands
  commands=(
${cmdLines}
  )

  _arguments -C \\
    '--json[Output as JSON]' \\
    '--claude-path[Override config path]:path:_files' \\
    '--tier[Search tier]:tier:(fuse minisearch sqlite)' \\
    '1:command:->cmds' \\
    '*::arg:->args'

  case "$state" in
    cmds)
      _describe -t commands 'vault commands' commands
      ;;
    args)
      case "\${words[1]}" in
        list|ls)
          _arguments \\
            '--type[Filter by type]:type:(skill agent command plugin rule hook)' \\
            '--source[Filter by source]:source:' \\
            '--tag[Filter by tag]:tag:' \\
            '--favorites[Show favorites only]'
          ;;
        search|s)
          _arguments \\
            '--type[Filter by type]:type:(skill agent command plugin rule hook)' \\
            '--source[Filter by source]:source:' \\
            '--limit[Max results]:limit:'
          ;;
        config)
          _arguments '1:subcommand:(get set)'
          ;;
        completions)
          _arguments '1:shell:(bash zsh fish powershell)'
          ;;
      esac
      ;;
  esac
}
compdef _vault vault
`;
}

function generateFish(): string {
  const lines = SUBCOMMANDS.map(
    (c) => `complete -c vault -n '__fish_use_subcommand' -a '${c}' -d '${c} command'`,
  );

  lines.push(
    '',
    "complete -c vault -n '__fish_use_subcommand' -l json -d 'Output as JSON'",
    "complete -c vault -n '__fish_use_subcommand' -l claude-path -d 'Override config path' -r",
    "complete -c vault -n '__fish_use_subcommand' -l tier -d 'Search tier' -ra 'fuse minisearch sqlite'",
    '',
    "complete -c vault -n '__fish_seen_subcommand_from list ls' -l type -d 'Filter by type' -ra 'skill agent command plugin rule hook'",
    "complete -c vault -n '__fish_seen_subcommand_from list ls' -l source -d 'Filter by source' -r",
    "complete -c vault -n '__fish_seen_subcommand_from list ls' -l tag -d 'Filter by tag' -r",
    "complete -c vault -n '__fish_seen_subcommand_from list ls' -l favorites -d 'Show favorites only'",
    '',
    "complete -c vault -n '__fish_seen_subcommand_from search s' -l type -d 'Filter by type' -ra 'skill agent command plugin rule hook'",
    "complete -c vault -n '__fish_seen_subcommand_from search s' -l source -d 'Filter by source' -r",
    "complete -c vault -n '__fish_seen_subcommand_from search s' -l limit -d 'Max results' -r",
    '',
    "complete -c vault -n '__fish_seen_subcommand_from config' -a 'get set' -d 'Config subcommand'",
    "complete -c vault -n '__fish_seen_subcommand_from completions' -a 'bash zsh fish powershell' -d 'Shell type'",
  );

  return `# vault shell completions for fish
# Add to ~/.config/fish/completions/vault.fish
${lines.join('\n')}
`;
}

function generatePowershell(): string {
  const cmds = SUBCOMMANDS.map((c) => `'${c}'`).join(', ');
  return `# vault shell completions for PowerShell
# Add to $PROFILE: vault completions powershell | Invoke-Expression
Register-ArgumentCompleter -Native -CommandName vault -ScriptBlock {
  param($wordToComplete, $commandAst, $cursorPosition)
  $commands = @(${cmds})

  $tokens = $commandAst.ToString().Split(' ', [System.StringSplitOptions]::RemoveEmptyEntries)

  if ($tokens.Count -eq 1 -or ($tokens.Count -eq 2 -and $wordToComplete)) {
    $commands | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object {
      [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_)
    }
  }
}
`;
}

const SHELLS: Readonly<Record<string, () => string>> = {
  bash: generateBash,
  zsh: generateZsh,
  fish: generateFish,
  powershell: generatePowershell,
};

export function createCompletionsCommand(): Command {
  const cmd = new Command('completions')
    .description('Generate shell completion scripts')
    .argument('<shell>', 'Shell type (bash|zsh|fish|powershell)')
    .action((shell: string) => {
      const generator = SHELLS[shell];
      if (!generator) {
        console.error(
          chalk.red(`Unknown shell: "${shell}". Supported: bash, zsh, fish, powershell`),
        );
        process.exitCode = 1;
        return;
      }
      process.stdout.write(generator());
    });

  return cmd;
}

export { generateBash, generateZsh, generateFish, generatePowershell, SUBCOMMANDS };
