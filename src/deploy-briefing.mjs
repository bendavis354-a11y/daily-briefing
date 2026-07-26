/**
 * Deploy the briefing and persist memory in one deterministic step.
 *
 * Commits index.html + .nojekyll + state.enc to the claude/briefing branch via
 * a temporary worktree, without disturbing the main checkout. Replaces the
 * hand-driven git choreography in the routine prompt.
 */
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { STATE_BRANCH, STATE_FILE } from './state-store.mjs';

const WT = '/tmp/briefing-deploy-wt';
const git = (args, opts = {}) => execFileSync('git', args, { stdio: 'pipe', ...opts }).toString();

for (const f of ['index.html', STATE_FILE]) {
  if (!fs.existsSync(f)) {
    console.error(`Missing ${f} — run the build and state-update steps first.`);
    process.exit(1);
  }
}

try { git(['worktree', 'remove', '--force', WT]); } catch {}
try { git(['fetch', 'origin', STATE_BRANCH]); } catch (err) { console.warn(`fetch: ${err.message}`); }

let hasRemote = true;
try { git(['rev-parse', '--verify', `origin/${STATE_BRANCH}`]); } catch { hasRemote = false; }

if (hasRemote) {
  git(['worktree', 'add', '--detach', WT, `origin/${STATE_BRANCH}`]);
} else {
  git(['worktree', 'add', '--detach', WT]);
  git(['-C', WT, 'rm', '-rf', '--quiet', '.']);
}

fs.copyFileSync('index.html', `${WT}/index.html`);
fs.copyFileSync(STATE_FILE, `${WT}/${STATE_FILE}`);
fs.writeFileSync(`${WT}/.nojekyll`, '');

git(['-C', WT, 'add', 'index.html', '.nojekyll', STATE_FILE]);
try {
  git(['-C', WT, 'diff', '--cached', '--quiet']);
  console.log('Nothing changed — no deploy needed.');
} catch {
  const date = new Date().toISOString().slice(0, 10);
  git(['-C', WT, 'commit', '-m', `Daily briefing ${date}`]);
  git(['-C', WT, 'push', 'origin', `HEAD:refs/heads/${STATE_BRANCH}`]);
  console.log(`Deployed briefing + state to ${STATE_BRANCH}.`);
}

try { git(['worktree', 'remove', '--force', WT]); } catch {}
