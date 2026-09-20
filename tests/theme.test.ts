/**
 * Theme tests.
 *
 * The resolution rule (light/dark/system + OS preference) is shared between the
 * pre-paint boot script and the React provider, so getting it wrong means either
 * a white flash or a toggle that disagrees with what is on screen. These tests
 * pin the rule and the script's contract.
 */
import { describe, expect, it } from 'vitest';
import {
  THEME_COLORS,
  THEME_INIT_SCRIPT,
  THEME_STORAGE_KEY,
  THEME_TRANSITION_GUARD_SCRIPT,
  resolveTheme,
} from '@/lib/theme';

describe('resolveTheme', () => {
  it('follows the OS when the preference is system', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
  });

  it('honours an explicit preference regardless of the OS', () => {
    expect(resolveTheme('dark', false)).toBe('dark');
    expect(resolveTheme('light', true)).toBe('light');
  });

  it('never returns "system" as a resolved theme', () => {
    for (const preference of ['light', 'dark', 'system'] as const) {
      for (const prefersDark of [true, false]) {
        expect(['light', 'dark']).toContain(resolveTheme(preference, prefersDark));
      }
    }
  });
});

describe('theme tokens', () => {
  it('defines a colour for each resolved theme', () => {
    expect(THEME_COLORS.light).toMatch(/^#[0-9a-f]{6}$/i);
    expect(THEME_COLORS.dark).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it('uses a dark (not pure black) surface and a light surface', () => {
    const luminance = (hex: string) => {
      const value = hex.replace('#', '');
      const [r, g, b] = [0, 2, 4].map((index) => parseInt(value.slice(index, index + 2), 16) / 255);
      return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
    };
    expect(luminance(THEME_COLORS.light)).toBeGreaterThan(0.8);
    expect(luminance(THEME_COLORS.dark)).toBeLessThan(0.1);
    // Not pure black: #000000 causes halation on OLED and hides elevation.
    expect(THEME_COLORS.dark).not.toBe('#000000');
  });
});

describe('THEME_INIT_SCRIPT', () => {
  it('reads the documented storage key', () => {
    expect(THEME_INIT_SCRIPT).toContain(THEME_STORAGE_KEY);
  });

  it('applies the dark class and the colour-scheme side effects', () => {
    expect(THEME_INIT_SCRIPT).toContain("classList.add('dark')");
    expect(THEME_INIT_SCRIPT).toContain("classList.remove('dark')");
    expect(THEME_INIT_SCRIPT).toContain('colorScheme');
    expect(THEME_INIT_SCRIPT).toContain('data-theme');
    expect(THEME_INIT_SCRIPT).toContain('theme-color');
  });

  it('queries the OS preference and tolerates storage being unavailable', () => {
    expect(THEME_INIT_SCRIPT).toContain('prefers-color-scheme: dark');
    // Both localStorage and matchMedia are wrapped, and the whole body is in a
    // try/catch: a blocked storage API must not break first paint.
    expect(THEME_INIT_SCRIPT).toContain('try{stored=localStorage.getItem(KEY);}catch(e){}');
    expect(THEME_INIT_SCRIPT).toContain('}catch(e){}})();');
  });

  it('embeds the storage key and theme colours literally, not via interpolation', () => {
    expect(THEME_INIT_SCRIPT).toContain(`"${THEME_STORAGE_KEY}"`);
    expect(THEME_INIT_SCRIPT).toContain(THEME_COLORS.dark);
    expect(THEME_INIT_SCRIPT).toContain(THEME_COLORS.light);
  });

  it('is a self-contained IIFE with no imports', () => {
    expect(THEME_INIT_SCRIPT.trim().startsWith('(function(){')).toBe(true);
    expect(THEME_INIT_SCRIPT).not.toContain('import ');
    expect(THEME_INIT_SCRIPT).not.toContain('require(');
  });

  it('is syntactically valid JavaScript', () => {
    // Parsing it here catches a broken escape before it reaches the browser as a
    // silently ignored inline script.
    expect(() => new Function(THEME_INIT_SCRIPT)).not.toThrow();
    expect(() => new Function(THEME_TRANSITION_GUARD_SCRIPT)).not.toThrow();
  });

  it('resolves the theme identically to resolveTheme for every combination', () => {
    // Execute the real script against a stub DOM and compare with the TS rule, so
    // the inline copy and the React provider can never drift apart.
    const expectations: Array<{ stored: string | null; prefersDark: boolean; expected: string }> = [
      { stored: null, prefersDark: true, expected: 'dark' },
      { stored: null, prefersDark: false, expected: 'light' },
      { stored: 'system', prefersDark: true, expected: 'dark' },
      { stored: 'system', prefersDark: false, expected: 'light' },
      { stored: 'dark', prefersDark: false, expected: 'dark' },
      { stored: 'light', prefersDark: true, expected: 'light' },
      { stored: 'garbage', prefersDark: true, expected: 'dark' },
    ];

    for (const { stored, prefersDark, expected } of expectations) {
      const classes = new Set<string>();
      const attributes: Record<string, string> = {};
      const styles: Record<string, string> = {};
      const meta = { setAttribute: (name: string, value: string) => { attributes[`meta:${name}`] = value; } };

      const sandbox = {
        localStorage: { getItem: () => stored },
        matchMedia: () => ({ matches: prefersDark }),
        document: {
          documentElement: {
            classList: {
              add: (value: string) => classes.add(value),
              remove: (value: string) => classes.delete(value),
            },
            style: styles,
            setAttribute: (name: string, value: string) => { attributes[name] = value; },
          },
          querySelector: () => meta,
          createElement: () => meta,
          head: { appendChild: () => undefined },
        },
      };

      // eslint-disable-next-line no-new-func
      new Function('window', 'document', 'localStorage', THEME_INIT_SCRIPT)(
        { matchMedia: sandbox.matchMedia },
        sandbox.document,
        sandbox.localStorage,
      );

      const applied = classes.has('dark') ? 'dark' : 'light';
      expect(applied, `stored=${stored} prefersDark=${prefersDark}`).toBe(expected);
      expect(applied).toBe(resolveTheme(stored === 'dark' || stored === 'light' ? stored : 'system', prefersDark));
      expect(styles.colorScheme).toBe(expected);
      expect(attributes['data-theme']).toBe(expected);
      expect(attributes['meta:content']).toBe(THEME_COLORS[expected as 'light' | 'dark']);
    }
  });
});

describe('THEME_TRANSITION_GUARD_SCRIPT', () => {
  it('adds and later removes the guard class', () => {
    expect(THEME_TRANSITION_GUARD_SCRIPT).toContain("classList.add('theme-transition-guard')");
    expect(THEME_TRANSITION_GUARD_SCRIPT).toContain("classList.remove('theme-transition-guard')");
    expect(THEME_TRANSITION_GUARD_SCRIPT).toContain('setTimeout');
  });
});
