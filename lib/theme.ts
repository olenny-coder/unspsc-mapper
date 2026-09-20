/**
 * Theme boot script.
 *
 * This string is injected into `<head>` and runs BEFORE the first paint, so the
 * correct theme class is on `<html>` when the body renders. Without it a dark-mode
 * user sees a white flash on every navigation.
 *
 * It must be dependency-free, synchronous, and safe to run twice. Kept as a
 * string constant (not a React component) so `dangerouslySetInnerHTML` cannot
 * mangle it and so it stays covered by a unit test.
 */

export const THEME_STORAGE_KEY = 'unspsc-theme';

export type ThemePreference = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

export const THEME_COLORS: Record<ResolvedTheme, string> = {
  light: '#ffffff',
  dark: '#020617',
};

/**
 * Resolve a preference to a concrete theme.
 *
 * Exported so the React provider and the unit tests share one implementation —
 * the inline script embeds the same logic in minified form.
 */
export function resolveTheme(preference: ThemePreference, prefersDark: boolean): ResolvedTheme {
  if (preference === 'system') return prefersDark ? 'dark' : 'light';
  return preference;
}

/** Inline script body. Runs before paint; must not throw. */
export const THEME_INIT_SCRIPT = `(function(){try{
var KEY=${JSON.stringify(THEME_STORAGE_KEY)};
var COLORS=${JSON.stringify(THEME_COLORS)};
var stored=null;
try{stored=localStorage.getItem(KEY);}catch(e){}
var pref=(stored==='light'||stored==='dark'||stored==='system')?stored:'system';
var prefersDark=false;
try{prefersDark=window.matchMedia('(prefers-color-scheme: dark)').matches;}catch(e){}
var resolved=pref==='system'?(prefersDark?'dark':'light'):pref;
var root=document.documentElement;
if(resolved==='dark'){root.classList.add('dark');}else{root.classList.remove('dark');}
root.style.colorScheme=resolved;
var meta=document.querySelector('meta[name="theme-color"]');
if(!meta){meta=document.createElement('meta');meta.setAttribute('name','theme-color');document.head.appendChild(meta);}
meta.setAttribute('content',COLORS[resolved]);
root.setAttribute('data-theme',resolved);
}catch(e){}})();`;

/**
 * Script that suppresses CSS transitions for one frame while the theme flips.
 * Without it, every element animates its colours and the switch looks broken.
 */
export const THEME_TRANSITION_GUARD_SCRIPT = `(function(){try{
var root=document.documentElement;
root.classList.add('theme-transition-guard');
window.clearTimeout(window.__themeGuardTimer);
window.__themeGuardTimer=window.setTimeout(function(){
root.classList.remove('theme-transition-guard');
},200);
}catch(e){}})();`;
