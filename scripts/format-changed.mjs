// Formats only the files that differ from HEAD: staged, unstaged, and untracked.
// Usage: pnpm format:changed [--check]
import { spawnSync } from 'node:child_process';

const git = (args) => {
  const result = spawnSync('git', args, { encoding: 'utf8' });
  if (result.status !== 0) {
    process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  }
  return result.stdout.split('\0').filter((path) => path !== '');
};

const root = git(['rev-parse', '--show-toplevel'])[0].trim();
process.chdir(root);

const files = [
  ...new Set([
    ...git(['diff', '-z', '--name-only', '--diff-filter=d', 'HEAD']),
    ...git(['ls-files', '-z', '--others', '--exclude-standard']),
  ]),
];

if (files.length === 0) {
  console.log('format:changed: no changed files');
  process.exit(0);
}

const mode = process.argv.includes('--check') ? '--check' : '--write';
const result = spawnSync('pnpm', ['exec', 'oxfmt', mode, '--no-error-on-unmatched-pattern', ...files], {
  stdio: 'inherit',
});
process.exit(result.status ?? 1);
