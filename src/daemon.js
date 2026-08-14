import { existsSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { paths, home, ensureHome, PKG_ROOT } from './config.js';

export const LABEL = 'software.pepper';

export function plistPath() {
  return join(homedir(), 'Library', 'LaunchAgents', LABEL + '.plist');
}

const NOT_MAC = 'launchd is a macOS thing — on this platform, keep Pepper on air with your own supervisor (systemd, pm2, or a tmux window you never close) running `pepper start`.';

const xml = (s) => String(s)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;');

function launchctl(args) {
  try {
    const r = spawnSync('launchctl', args, { encoding: 'utf8', timeout: 15000 });
    return {
      status: r.status ?? -1,
      out: (r.stdout || '') + (r.stderr || ''),
      error: r.error || null,
    };
  } catch (e) {
    return { status: -1, out: '', error: e };
  }
}

// process.execPath is symlink-resolved into version-pinned dirs (Homebrew
// Cellar, nvm versions) that vanish on upgrade — a plist frozen to one would
// silently kill the 24/7 daemon later. Prefer the stable public symlink.
function stableNodePath() {
  const p = process.execPath;
  const m = p.match(/^(\/opt\/homebrew|\/usr\/local)\/Cellar\/node(?:@\d+)?\/[^/]+\/bin\/node$/);
  if (m) {
    const link = m[1] + '/bin/node';
    if (existsSync(link)) return link;
  }
  return p;
}

function buildPlist() {
  const binPath = join(PKG_ROOT, 'bin', 'pepper.js');
  const envBlock = process.env.PEPPER_HOME
    ? `
  <key>EnvironmentVariables</key>
  <dict>
    <key>PEPPER_HOME</key>
    <string>${xml(process.env.PEPPER_HOME)}</string>
  </dict>`
    : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(stableNodePath())}</string>
    <string>${xml(binPath)}</string>
    <string>start</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>WorkingDirectory</key>
  <string>${xml(home())}</string>
  <key>StandardOutPath</key>
  <string>${xml(join(paths.logsDir, 'pepper.log'))}</string>
  <key>StandardErrorPath</key>
  <string>${xml(join(paths.logsDir, 'pepper.err.log'))}</string>${envBlock}
</dict>
</plist>
`;
}

export function install() {
  if (process.platform !== 'darwin') return { ok: false, message: NOT_MAC };
  try {
    ensureHome();
    const plist = plistPath();
    mkdirSync(dirname(plist), { recursive: true });
    writeFileSync(plist, buildPlist());
    const uid = process.getuid();
    // Quietly unload any previous incarnation so reinstall is idempotent.
    launchctl(['bootout', `gui/${uid}/${LABEL}`]);
    let r = launchctl(['bootstrap', `gui/${uid}`, plist]);
    if (r.status !== 0) r = launchctl(['load', '-w', plist]);
    if (r.status !== 0) {
      const why = r.out.trim() || r.error?.message || 'unknown launchctl error';
      return { ok: false, message: `wrote ${plist}, but launchctl refused to load it: ${why}` };
    }
    return {
      ok: true,
      message: `Pepper is on the desk 24/7 — agent ${LABEL} loaded.\n    plist  ${plist}\n    logs   ${paths.logsDir}`,
    };
  } catch (e) {
    return { ok: false, message: 'install failed: ' + String(e?.message || e) };
  }
}

export function uninstall() {
  if (process.platform !== 'darwin') return { ok: false, message: NOT_MAC };
  try {
    const plist = plistPath();
    const wasThere = existsSync(plist);
    const uid = process.getuid();
    const r = launchctl(['bootout', `gui/${uid}/${LABEL}`]);
    if (r.status !== 0) launchctl(['unload', '-w', plist]);
    try { unlinkSync(plist); } catch {}
    return {
      ok: true,
      message: wasThere
        ? 'Pepper is off the clock — launchd agent removed.'
        : 'no launchd agent was installed — nothing to remove.',
    };
  } catch (e) {
    return { ok: false, message: 'uninstall failed: ' + String(e?.message || e) };
  }
}

export function status() {
  if (process.platform !== 'darwin') {
    return { supported: false, installed: false, running: false, pid: null, message: 'launchd not available on ' + process.platform };
  }
  try {
    const installed = existsSync(plistPath());
    const r = launchctl(['print', `gui/${process.getuid()}/${LABEL}`]);
    if (r.status !== 0) {
      return {
        supported: true,
        installed,
        running: false,
        pid: null,
        message: installed ? 'installed, not loaded — try `pepper daemon install` again' : 'not installed',
      };
    }
    const pid = Number((r.out.match(/\bpid = (\d+)/) || [])[1]) || null;
    const running = /\bstate = running\b/.test(r.out) || pid != null;
    return {
      supported: true,
      installed: true,
      running,
      pid,
      message: running ? `running (pid ${pid ?? '?'})` : 'loaded, not running',
    };
  } catch (e) {
    return { supported: true, installed: false, running: false, pid: null, message: 'status failed: ' + String(e?.message || e) };
  }
}
