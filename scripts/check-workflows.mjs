/**
 * Validate the GitHub Actions workflow files.
 *
 * This exists because a workflow that uses `secrets` (or any other unavailable
 * context) inside a step-level `if` is rejected by GitHub as an *invalid file*: the
 * run fails before a single job starts, and the message blames line 1:
 *
 *   Invalid workflow file: .github/workflows/ci.yml#L1
 *   (Line: 139, Col: 13): Unrecognized named-value: 'secrets'
 *
 * That is a miserable thing to debug from the Actions page, and — importantly — it
 * cannot be caught by a job *inside* the broken workflow, because GitHub never loads
 * it. A note in CI is therefore impossible; the check has to be local, or in a
 * separate workflow.
 *
 * `actionlint` (https://github.com/rhysd/actionlint) encodes GitHub's context
 * availability rules and reports the same error GitHub does, so it is used when
 * present. Without it this script is a no-op rather than a failure, so it can sit in
 * `check:all` on a machine that has not installed it.
 *
 * Usage:
 *   npm run workflow:check
 *   ACTIONLINT=/path/to/actionlint npm run workflow:check
 */
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const WORKFLOW_DIR = resolve('.github', 'workflows');

/** Where a developer is most likely to have put it, plus the platform names. */
function findActionlint() {
  if (process.env.ACTIONLINT && existsSync(process.env.ACTIONLINT)) return process.env.ACTIONLINT;

  for (const name of ['actionlint', 'actionlint.exe']) {
    const probe = spawnSync(name, ['--version'], { stdio: 'ignore', shell: false });
    if (!probe.error && probe.status === 0) return name;
  }
  return null;
}

function workflowFiles() {
  if (!existsSync(WORKFLOW_DIR)) return [];
  return readdirSync(WORKFLOW_DIR)
    .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
    .map((name) => join(WORKFLOW_DIR, name));
}

const files = workflowFiles();
if (!files.length) {
  console.log('No workflow files found; nothing to check.');
  process.exit(0);
}

const actionlint = findActionlint();

if (!actionlint) {
  console.log('actionlint is not installed, so the workflow files were not validated.');
  console.log('');
  console.log('Worth installing: GitHub rejects an entire workflow file when a context is');
  console.log('used where it is not available (for example `secrets` inside a step-level');
  console.log('`if`), and the run then fails before any job starts, blaming line 1.');
  console.log('');
  console.log('  Windows:  scoop install actionlint   |   choco install actionlint');
  console.log('  macOS:    brew install actionlint');
  console.log('  Linux:    bash <(curl https://raw.githubusercontent.com/rhysd/actionlint/main/scripts/download-actionlint.bash)');
  console.log('  Go:       go install github.com/rhysd/actionlint/cmd/actionlint@latest');
  console.log('');
  console.log(`Checked-in files that would be validated: ${files.length}`);
  process.exit(0);
}

console.log(`Validating ${files.length} workflow file(s) with ${actionlint}…`);
const result = spawnSync(actionlint, ['-color', ...files], { stdio: 'inherit' });

if (result.error) {
  console.error(`Could not run actionlint: ${result.error.message}`);
  process.exit(1);
}

if (result.status !== 0) {
  console.error('');
  console.error('Workflow validation failed. GitHub will refuse to load the file(s) above.');
  process.exit(result.status ?? 1);
}

console.log('Workflow files are valid.');
