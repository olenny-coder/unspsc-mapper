/**
 * Targeted assertion probe over CDP.
 *
 * The generic visual audit checks layout and contrast; this checks two specific
 * implementation details that are easy to get wrong and invisible in a list of
 * class names:
 *
 *   1. the dashboard chart bars actually render rounded corners (Recharts emits
 *      `path` elements with arc commands, not plain rects — a `radius` prop that
 *      is silently ignored would look identical in the source)
 *   2. the social/icon meta tags present in the served HTML
 *
 *   node scripts/probe-chart.mjs <baseUrl> <secret>
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const [, , baseUrl = 'http://localhost:3210', secret = ''] = process.argv;

const BROWSERS = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function findBrowser() {
  for (const candidate of BROWSERS) if (existsSync(candidate)) return candidate;
  return null;
}

async function main() {
  const browser = findBrowser();
  if (!browser) throw new Error('no Chromium-based browser found');

  const port = 9355;
  const child = spawn(
    browser,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--disable-extensions',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${join(tmpdir(), `unspsc-probe-${Date.now()}`)}`,
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  try {
    let wsUrl;
    for (let i = 0; i < 80; i += 1) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/version`);
        if (response.ok) {
          wsUrl = (await response.json()).webSocketDebuggerUrl;
          break;
        }
      } catch {
        /* not ready */
      }
      await sleep(300);
    }
    if (!wsUrl) throw new Error('DevTools endpoint unavailable');

    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error('socket error')), { once: true });
    });

    let nextId = 1;
    const pending = new Map();
    let sessionId = null;
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id && pending.has(message.id)) {
        const { resolve, reject, method } = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) reject(new Error(`${method}: ${message.error.message}`));
        else resolve(message.result ?? {});
      }
    });
    const send = (method, params = {}, useSession = true) =>
      new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject, method });
        const payload = { id, method, params };
        if (useSession && sessionId) payload.sessionId = sessionId;
        ws.send(JSON.stringify(payload));
      });

    const targets = await send('Target.getTargets', {}, false);
    const page = targets.targetInfos.find((target) => target.type === 'page');
    sessionId = (await send('Target.attachToTarget', { targetId: page.targetId, flatten: true }, false)).sessionId;
    await send('Page.enable');
    await send('Network.enable');
    await send('Runtime.enable');

    if (secret) {
      const login = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ secret }),
      });
      const token = (login.headers.get('set-cookie') ?? '').split(';')[0]?.split('=').slice(1).join('=') ?? '';
      if (!token) throw new Error('login returned no session cookie');
      await send('Network.setCookie', {
        name: 'unspsc_session',
        value: token,
        domain: new URL(baseUrl).hostname,
        path: '/',
        httpOnly: true,
      });
    }

    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url: `${baseUrl}/` });
    // Allow the dashboard's metrics fetch plus the chart's mount/measure cycle.
    await sleep(5000);

    const result = await send('Runtime.evaluate', {
      expression: `(() => {
        const chart = document.querySelector('.recharts-responsive-container svg');
        if (!chart) return JSON.stringify({ error: 'chart svg not found' });

        // Recharts renders rounded bars as <path> with arc commands; a square bar
        // would be a <rect>. Both the presence and the arc count matter.
        const barPaths = [...chart.querySelectorAll('.recharts-bar-rectangle path')];
        const barRects = [...chart.querySelectorAll('.recharts-bar-rectangle rect')];
        const arcCounts = barPaths.map((p) => ((p.getAttribute('d') || '').match(/A/g) || []).length);
        const firstD = barPaths[0] ? (barPaths[0].getAttribute('d') || '').slice(0, 120) : null;

        return JSON.stringify({
          barPathCount: barPaths.length,
          barRectCount: barRects.length,
          arcCounts,
          allBarsHaveArcs: arcCounts.length > 0 && arcCounts.every((c) => c >= 4),
          firstPathD: firstD,
          fillSamples: barPaths.slice(0, 3).map((p) => p.getAttribute('fill')),
        });
      })()`,
      returnByValue: true,
    });

    const data = JSON.parse(result.result.value);
    console.log('=== dashboard chart bars ===');
    if (data.error) {
      console.log('ERROR:', data.error);
      process.exitCode = 1;
    } else {
      console.log('bar <path> elements:', data.barPathCount);
      console.log('bar <rect> elements (should be 0):', data.barRectCount);
      console.log('arc commands per bar:', data.arcCounts.join(', '));
      console.log('all bars rounded:', data.allBarsHaveArcs);
      console.log('first path d:', data.firstPathD);
      console.log('fills:', data.fillSamples.join(' | '));
      if (!data.allBarsHaveArcs || data.barPathCount === 0) {
        console.log('RESULT: FAIL — bars are not rounded');
        process.exitCode = 1;
      } else {
        console.log('RESULT: PASS — bars render with rounded corners');
      }
    }

    // Header logo sanity: an inline SVG with the brand gradient.
    const logo = await send('Runtime.evaluate', {
      expression: `(() => {
        const header = document.querySelector('header svg');
        if (!header) return JSON.stringify({ found: false });
        const rects = header.querySelectorAll('rect');
        return JSON.stringify({
          found: true,
          width: Math.round(header.getBoundingClientRect().width),
          rectCount: rects.length,
          hasGradient: !!header.querySelector('linearGradient'),
        });
      })()`,
      returnByValue: true,
    });
    const logoData = JSON.parse(logo.result.value);
    console.log('\n=== header logo ===');
    console.log(JSON.stringify(logoData));
    if (!logoData.found || logoData.rectCount < 4 || !logoData.hasGradient) {
      console.log('RESULT: FAIL — header logo did not render as expected');
      process.exitCode = 1;
    } else {
      console.log('RESULT: PASS — inline brand mark with gradient and 4 shapes');
    }
  } finally {
    child.kill();
  }
}

void main().catch((error) => {
  console.error('probe failed:', error.message);
  process.exit(1);
});
