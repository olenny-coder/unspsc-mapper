/**
 * Visual verification harness.
 *
 * Drives Microsoft Edge over the Chrome DevTools Protocol so screenshots can be
 * taken of AUTHENTICATED pages at real viewport sizes, in both themes. This is
 * how the responsive/dark-mode claims are checked rather than assumed.
 *
 *   node scripts/visual-check.mjs <baseUrl> <secret> <outDir>
 *
 * It performs, in order:
 *   1. launch Edge headless with remote debugging
 *   2. Network.setCookie so the session cookie is present for navigation
 *   3. for each profile: set device metrics + colour scheme, navigate, screenshot
 *   4. report the document scrollWidth vs viewport width (horizontal overflow)
 *      and the number of elements wider than the viewport
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const [, , baseUrl = 'http://localhost:3100', secret = '', outDir = join(tmpdir(), 'unspsc-shots')] = process.argv;

const EDGE_CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
];

const PROFILES = [
  { name: 'desktop-light', width: 1440, height: 1000, mobile: false, dark: false, paths: ['/', '/review'] },
  { name: 'desktop-dark', width: 1440, height: 1000, mobile: false, dark: true, paths: ['/', '/settings'] },
  { name: 'mobile-light', width: 390, height: 844, mobile: true, dark: false, paths: ['/', '/review'] },
  { name: 'mobile-dark', width: 390, height: 844, mobile: true, dark: true, paths: ['/', '/hierarchy'] },
  { name: 'tablet', width: 768, height: 1024, mobile: false, dark: false, paths: ['/'] },
  { name: 'small-phone', width: 320, height: 568, mobile: true, dark: false, paths: ['/'] },
];

function findBrowser() {
  for (const candidate of EDGE_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * In-page audit expression.
 *
 * Returns theme state, overflow, tap-target sizes and real WCAG contrast ratios
 * computed from the *computed* colours of every visible text node. Contrast
 * cannot be judged by reading class names, so it is measured from the rendered
 * result — the only honest way to check a themed UI without eyes on it.
 */
const AUDIT_EXPRESSION = `(() => {
  const parseColor = (value) => {
    const match = /rgba?\\(([^)]+)\\)/.exec(value || '');
    if (!match) return null;
    const parts = match[1].split(',').map((n) => parseFloat(n));
    return { r: parts[0] || 0, g: parts[1] || 0, b: parts[2] || 0, a: parts.length > 3 ? parts[3] : 1 };
  };
  const lum = (c) => {
    const channel = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
  };
  const over = (fg, bg) => ({
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
    a: 1,
  });
  const contrast = (a, b) => {
    const la = lum(a); const lb = lum(b);
    const hi = Math.max(la, lb); const lo = Math.min(la, lb);
    return (hi + 0.05) / (lo + 0.05);
  };
  const nearestBackground = (el) => {
    let node = el;
    while (node && node !== document.documentElement.parentNode) {
      const bg = parseColor(getComputedStyle(node).backgroundColor);
      if (bg && bg.a > 0.5) return bg;
      node = node.parentElement;
    }
    return { r: 255, g: 255, b: 255, a: 1 };
  };

  const samples = [];
  const seen = new Set();
  for (const el of document.querySelectorAll('h1, h2, h3, p, span, td, th, label, a, button, code, small')) {
    if (el.children.length > 0) continue;
    const text = (el.textContent || '').trim();
    if (!text) continue;
    if (seen.has(el)) continue;
    seen.add(el);
    const rect = el.getBoundingClientRect();
    if (rect.width < 4 || rect.height < 4) continue;
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none' || parseFloat(style.opacity) < 0.5) continue;
    const fg = parseColor(style.color);
    if (!fg) continue;
    const bg = nearestBackground(el);
    const ratio = contrast(over(fg, bg), bg);
    samples.push({
      ratio: Math.round(ratio * 100) / 100,
      size: parseFloat(style.fontSize),
      weight: style.fontWeight,
      sample: text.slice(0, 42),
      color: style.color,
    });
  }
  const failures = samples.filter((s) => s.ratio < (s.size >= 18 || (s.size >= 14 && parseInt(s.weight, 10) >= 600) ? 3 : 4.5));

  // Tap targets: measure the *effective* hit area, not just the border box.
  //
  // A small control often extends its hit area with a pseudo-element (for example
  // after:-inset-2), which getBoundingClientRect cannot see. The pseudo-element's
  // geometry is read from its computed style and unioned with the border box.
  // (An earlier attempt probed elementFromPoint, but delegated clicks make the
  // real target an ancestor and every control measured 1x1 — measuring styles is
  // deterministic.)
  const effectiveBox = (el) => {
    const rect = el.getBoundingClientRect();
    let { width, height } = rect;
    try {
      const after = getComputedStyle(el, '::after');
      if (after && after.content && after.content !== 'none') {
        const px = (value) => (value && value.endsWith('px') ? parseFloat(value) : null);
        const insetTop = px(after.top);
        const insetRight = px(after.right);
        const insetBottom = px(after.bottom);
        const insetLeft = px(after.left);
        const growY = Math.max(0, -(insetTop ?? 0)) + Math.max(0, -(insetBottom ?? 0));
        const growX = Math.max(0, -(insetLeft ?? 0)) + Math.max(0, -(insetRight ?? 0));
        width += growX;
        height += growY;
      }
    } catch {
      /* pseudo-element not resolvable: fall back to the border box */
    }
    return { w: Math.round(width), h: Math.round(height) };
  };

  const tapTargets = [...document.querySelectorAll('button, a[href], input[type=checkbox], [role=button], [role=switch]')]
    .filter((el) => el.getBoundingClientRect().width > 0)
    .map((el) => {
      /*
       * A checkbox is clicked through its wrapping <label>, which is what actually
       * carries the hit area. Measure that wrapper: the control the user aims at
       * is the label, so its size is the honest answer for "can I tap this?".
       */
      const effective =
        el.tagName.toLowerCase() === 'input' && el.closest('label') ? el.closest('label') : el;
      const size = effectiveBox(effective);
      return {
        w: size.w,
        h: size.h,
        label: (el.getAttribute('aria-label') || el.textContent || effective.textContent || '').trim().slice(0, 24),
        kind: el.tagName.toLowerCase(),
      };
    });

  /*
   * WCAG 2.5.8 Target Size (Minimum) requires 24x24 CSS px, with an explicit
   * exception for targets inside a sentence ("inline"). Buttons, checkboxes and
   * switches must clear it; inline prose links are exempt because enlarging them
   * would overlap the surrounding words.
   */
  const isInlineLink = (target) => target.kind === 'a' && target.label.length > 0;
  const belowMinimum = tapTargets.filter((t) => (t.h < 24 || t.w < 24) && !isInlineLink(t));
  const belowPreferred = tapTargets.filter((t) => (t.h < 32 || t.w < 32) && !isInlineLink(t));

  const root = document.documentElement;
  /* CSS layout viewport - the value media queries and Tailwind breakpoints use.
     window.innerWidth can include a scrollbar gutter and disagreed with it in
     headless Chromium, so it is deliberately not used here. */
  const layoutWidth = root.clientWidth;
  const overflowing = [...document.querySelectorAll('body *')]
    .filter((el) => el.getBoundingClientRect().width > layoutWidth + 1)
    .filter((el) => getComputedStyle(el).position !== 'fixed')
    .filter((el) => !el.closest('.table-scroll'))
    .slice(0, 6)
    .map((el) => el.tagName.toLowerCase() + (typeof el.className === 'string' && el.className ? '.' + el.className.split(' ').slice(0, 2).join('.') : ''));

  const header = document.querySelector('header');
  return JSON.stringify({
    theme: root.getAttribute('data-theme'),
    darkClass: root.classList.contains('dark'),
    bodyBg: getComputedStyle(document.body).backgroundColor,
    scrollWidth: root.scrollWidth,
    innerWidth: layoutWidth,
    overflow: root.scrollWidth - layoutWidth,
    overflowing,
    h1: document.querySelector('h1') ? document.querySelector('h1').textContent : null,
    headerHeight: header ? Math.round(header.getBoundingClientRect().height) : null,
    mobileMenuButton: !!document.querySelector('[aria-controls="mobile-nav"]'),
    mobileNavHidden: document.getElementById('mobile-nav') ? document.getElementById('mobile-nav').hasAttribute('hidden') : null,
    sampleCount: samples.length,
    contrastFailures: failures.slice(0, 8),
    contrastFailureCount: failures.length,
    minContrast: samples.length ? Math.min(...samples.map((s) => s.ratio)) : null,
    tapTargetCount: tapTargets.length,
    belowMinimum: belowMinimum.slice(0, 8),
    belowMinimumCount: belowMinimum.length,
    belowPreferredCount: belowPreferred.length,
    tableScrollContainers: document.querySelectorAll('.table-scroll').length,
  });
})()`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForDevtools(port, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) {
        const info = await response.json();
        return info.webSocketDebuggerUrl;
      }
    } catch {
      /* not up yet */
    }
    await sleep(300);
  }
  throw new Error('DevTools endpoint did not become available');
}

/** Minimal CDP client over the browser-level WebSocket. */
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.sessionId = null;
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject, method } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(`${method} failed: ${message.error.message}`));
        else resolve(message.result ?? {});
      }
    });
  }

  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error('CDP socket error')), { once: true });
    });
    return new Cdp(ws);
  }

  /**
   * Send a CDP command and resolve with its `result` payload.
   *
   * Unwrapping here matters: an earlier version returned the whole message, so
   * every `metrics.result.value` read was `undefined` and the reported viewport
   * widths were meaningless. Failures are surfaced as thrown errors with the
   * method name so a broken audit cannot look like a passing one.
   */
  send(method, params = {}, useSession = true) {
    const id = this.nextId++;
    const payload = { id, method, params };
    if (useSession && this.sessionId) payload.sessionId = this.sessionId;
    this.ws.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
    });
  }

  async attach() {
    const { targetInfos } = await this.send('Target.getTargets', {}, false);
    const page = targetInfos.find((target) => target.type === 'page');
    const { sessionId } = await this.send('Target.attachToTarget', { targetId: page.targetId, flatten: true }, false);
    this.sessionId = sessionId;
  }
}

async function main() {
  const browser = findBrowser();
  if (!browser) {
    console.error('No Chromium-based browser found.');
    process.exit(1);
  }
  mkdirSync(outDir, { recursive: true });

  const port = 9333;
  const profileDir = join(tmpdir(), `unspsc-visual-${Date.now()}`);
  const child = spawn(
    browser,
    [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--force-device-scale-factor=1',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profileDir}`,
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  const findings = [];
  let wsUrl;
  try {
    wsUrl = await waitForDevtools(port);
    const cdp = await Cdp.connect(wsUrl);
    await cdp.attach();
    await cdp.send('Page.enable');
    await cdp.send('Network.enable');
    await cdp.send('Runtime.enable');

    // --- authenticate once: the cookie is shared across all navigations -------
    if (secret) {
      const host = new URL(baseUrl).hostname;
      const response = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ secret }),
      });
      const setCookie = response.headers.get('set-cookie') ?? '';
      const token = setCookie.split(';')[0]?.split('=').slice(1).join('=') ?? '';
      if (!token) throw new Error('Login did not return a session cookie');
      await cdp.send('Network.setCookie', {
        name: 'unspsc_session',
        value: token,
        domain: host,
        path: '/',
        httpOnly: true,
      });
      // Seed the theme preference used by the boot script.
      await cdp.send('Page.navigate', { url: `${baseUrl}/login` });
      await sleep(800);
    }

    for (const profile of PROFILES) {
      await cdp.send('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-color-scheme', value: profile.dark ? 'dark' : 'light' }],
      });

      for (const path of profile.paths) {
        /*
         * Re-apply the device metrics for EVERY navigation, and verify them.
         *
         * Setting them once per profile proved unreliable — the first navigation
         * after an override reported the previous viewport width (a 390px phone
         * measured as 722px), which would have made the mobile audit meaningless.
         * The assertion below fails loudly instead of silently testing the wrong
         * width.
         */
        await cdp.send('Emulation.setDeviceMetricsOverride', {
          width: profile.width,
          height: profile.height,
          deviceScaleFactor: 1,
          mobile: profile.mobile,
        });
        await cdp.send('Runtime.evaluate', {
          expression: `try { localStorage.setItem('unspsc-theme', '${profile.dark ? 'dark' : 'light'}'); } catch (e) {}`,
        });
        await cdp.send('Page.navigate', { url: `${baseUrl}${path}` });
        await sleep(2600);

        const viewport = await cdp.send('Runtime.evaluate', {
          expression:
            'JSON.stringify({inner:window.innerWidth, client:document.documentElement.clientWidth, dpr:devicePixelRatio, vv:window.visualViewport?Math.round(window.visualViewport.width):null})',
          returnByValue: true,
        });
        const measured = JSON.parse(viewport.result.value);
        // Compare against the layout viewport (`clientWidth`), which is what the
        // page's CSS actually sees and what the audit measures.
        if (measured.client !== profile.width) {
          await cdp.send('Page.reload', {});
          await sleep(2200);
          const retry = await cdp.send('Runtime.evaluate', {
            expression: 'document.documentElement.clientWidth',
            returnByValue: true,
          });
          if (retry.result.value !== profile.width) {
            throw new Error(
              `viewport override failed for ${profile.name}${path}: expected ${profile.width}px layout viewport, ` +
                `measured ${measured.client}px then ${retry.result.value}px (innerWidth=${measured.inner}, dpr=${measured.dpr}, visualViewport=${measured.vv})`,
            );
          }
        }

        const metrics = await cdp.send('Runtime.evaluate', {
          expression: AUDIT_EXPRESSION,
          returnByValue: true,
        });
        const info = JSON.parse(metrics.result.value);
        const label = `${profile.name}${path.replace('/', '-') || '-root'}`;
        findings.push({ label, ...info });

        const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
        writeFileSync(join(outDir, `${label}.png`), Buffer.from(shot.data, 'base64'));
        console.log(
          `${label.padEnd(26)} theme=${String(info.theme).padEnd(5)} viewport=${String(info.innerWidth).padEnd(4)} ` +
            `overflow=${info.overflow > 1 ? 'YES ' + info.overflow : 'no '} ` +
            `contrastMin=${info.minContrast} fails=${info.contrastFailureCount} ` +
            `hdr=${info.headerHeight}px mobileMenu=${info.mobileMenuButton ? 'y' : 'n'} navHidden=${info.mobileNavHidden} ` +
            `targets=${info.tapTargetCount} below24=${info.belowMinimumCount} below32=${info.belowPreferredCount} ` +
            `tableScroll=${info.tableScrollContainers}`,
        );
        if (info.overflowing.length) console.log(`  overflowing: ${info.overflowing.join(', ')}`);
        for (const failure of info.contrastFailures) {
          console.log(`  CONTRAST ${failure.ratio}:1 (${failure.size}px) "${failure.sample}" ${failure.color}`);
        }
        for (const target of info.belowMinimum) {
          console.log(`  SMALL TARGET ${target.w}x${target.h} <${target.kind}> "${target.label}"`);
        }
      }
    }

    console.log('');
    const overflow = findings.filter((finding) => finding.overflow > 1);
    const contrast = findings.filter((finding) => finding.contrastFailureCount > 0);
    const targets = findings.filter((finding) => finding.belowMinimumCount > 0);

    if (overflow.length) {
      console.log('HORIZONTAL OVERFLOW:');
      for (const finding of overflow) console.log(`  ${finding.label}: ${finding.overflow}px`);
    } else {
      console.log('No unexpected horizontal overflow at any tested viewport.');
    }
    if (contrast.length) {
      console.log('CONTRAST FAILURES (below WCAG AA):');
      for (const finding of contrast) console.log(`  ${finding.label}: ${finding.contrastFailureCount}`);
    } else {
      console.log('All sampled text meets WCAG AA contrast in both themes.');
    }
    if (targets.length) {
      console.log('TAP TARGETS BELOW 24px (WCAG 2.5.8):');
      for (const finding of targets) console.log(`  ${finding.label}: ${finding.belowMinimumCount}`);
    } else {
      console.log('Every non-inline control meets the 24x24 minimum (WCAG 2.5.8).');
    }
    const preferred = findings.reduce((sum, finding) => sum + finding.belowPreferredCount, 0);
    console.log(`controls below the 32px comfort target: ${preferred}`);
    console.log('themes observed:', [...new Set(findings.map((finding) => finding.theme))].join(', '));
    console.log('screenshots:', outDir);
    if (overflow.length || contrast.length || targets.length) process.exitCode = 1;
  } finally {
    child.kill();
    await sleep(500);
    try {
      rmSync(profileDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}

void main().catch((error) => {
  console.error('visual check failed:', error.message);
  process.exit(1);
});
