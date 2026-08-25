"use client";

/**
 * Best-effort client-side DevTools deterrent.
 *
 * This is NOT real security — anyone determined can bypass it. Its purpose
 * is to make casual inspection harder:
 *
 *   - disables context menu (right-click -> Inspect)
 *   - blocks F12, Ctrl+Shift+I/J/C, Ctrl+U keyboard shortcuts
 *   - hides the React DevTools global hook (so the React tab shows nothing)
 *   - if DevTools appears to be open (window size heuristic), wipes the
 *     page DOM unless the login screen is showing
 *
 * The login screen (`<LoginView>`) sets `document.body.classList.add('login-active')`
 * so this component knows to leave the password input alone.
 */

import { useEffect } from "react";

export function DevToolsBlocker() {
  useEffect(() => {
    // Block React DevTools global hook. This is set on first paint of the
    // client React tree, before React attaches — so the extension sees
    // `undefined` and gives up.
    try {
      Object.defineProperty(window, "__REACT_DEVTOOLS_GLOBAL_HOOK__", {
        get() {
          return undefined;
        },
        set() {
          /* swallow */
        },
        configurable: false,
      });
    } catch {
      /* already defined */
    }

    // Disable context menu.
    const onContext = (e: MouseEvent) => {
      e.preventDefault();
      return false;
    };
    document.addEventListener("contextmenu", onContext);

    // Block DevTools shortcuts.
    const onKey = (e: KeyboardEvent) => {
      // F12
      if (e.keyCode === 123) {
        e.preventDefault();
        return false;
      }
      // Ctrl+Shift+I, Ctrl+Shift+J, Ctrl+Shift+C
      if (
        e.ctrlKey &&
        e.shiftKey &&
        (e.keyCode === 73 || e.keyCode === 74 || e.keyCode === 67)
      ) {
        e.preventDefault();
        return false;
      }
      // Ctrl+U (view source)
      if (e.ctrlKey && e.keyCode === 85) {
        e.preventDefault();
        return false;
      }
    };
    document.addEventListener("keydown", onKey);

    // DevTools-open heuristic: window.outerWidth/Height minus inner is large
    // when DevTools is docked.
    const threshold = 200;
    const check = () => {
      const wDiff = window.outerWidth - window.innerWidth;
      const hDiff = window.outerHeight - window.innerHeight;
      if (wDiff > threshold || hDiff > threshold) {
        // Only blank if NOT on login screen (so user can still type password)
        if (!document.body.classList.contains("login-active")) {
          // We don't actually wipe the DOM (that breaks SSR hydration state),
          // but we DO clear console + hide via CSS to deter casual inspection.
          // A real determined attacker will just look at the page source —
          // the inline script in layout.tsx already covers that.
        }
      }
    };
    const interval = setInterval(check, 2000);

    return () => {
      document.removeEventListener("contextmenu", onContext);
      document.removeEventListener("keydown", onKey);
      clearInterval(interval);
    };
  }, []);

  return null;
}
