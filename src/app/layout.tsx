import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { DevToolsBlocker } from "@/components/DevToolsBlocker";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// Generic metadata — no hints about what this app actually does.
// An attacker viewing page source shouldn't be able to tell this is a tor
// relay, a proxy, or anything specific.
export const metadata: Metadata = {
  title: "dashboard",
  description: "dashboard",
  robots: { index: false, follow: false },
  icons: {
    // No icon hint either.
    icon: [{ url: "data:," }],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning className="dark">
      <head>
        {/* Block React DevTools from attaching. This is best-effort — a
            determined attacker can patch it, but casual inspection with the
            React DevTools browser extension will see nothing. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `
              (function() {
                // Block React DevTools global hook
                try {
                  Object.defineProperty(window, '__REACT_DEVTOOLS_GLOBAL_HOOK__', {
                    get: function() { return undefined; },
                    set: function() { /* swallow */ },
                    configurable: false,
                  });
                } catch (e) {}

                // Block Next.js DevTools signals
                try {
                  if (window.__NEXT_DATA__) {
                    Object.defineProperty(window, '__NEXT_DATA__', {
                      value: { props: {}, page: '/', query: {} },
                      writable: false,
                      configurable: false,
                    });
                  }
                } catch (e) {}

                // Disable console.debug / console.trace in production to make
                // inspection harder. We keep .log/.warn/.error for legit use.
                try {
                  if (window.console) {
                    console.debug = function() {};
                    console.trace = function() {};
                  }
                } catch (e) {}

                // Disable right-click context menu (keeps casual users from
                // clicking "Inspect" easily). Power users can still open
                // DevTools via keyboard shortcut.
                try {
                  document.addEventListener('contextmenu', function(e) {
                    e.preventDefault();
                    return false;
                  });
                } catch (e) {}

                // Disable common DevTools keyboard shortcuts (F12, Ctrl+Shift+I/J/C).
                // This is best-effort — it won't stop a determined attacker but
                // raises the bar for casual inspection.
                try {
                  document.addEventListener('keydown', function(e) {
                    // F12
                    if (e.keyCode === 123) {
                      e.preventDefault();
                      return false;
                    }
                    // Ctrl+Shift+I, Ctrl+Shift+J, Ctrl+Shift+C
                    if (e.ctrlKey && e.shiftKey && (e.keyCode === 73 || e.keyCode === 74 || e.keyCode === 67)) {
                      e.preventDefault();
                      return false;
                    }
                    // Ctrl+U (view source)
                    if (e.ctrlKey && e.keyCode === 85) {
                      e.preventDefault();
                      return false;
                    }
                  });
                } catch (e) {}

                // Detect DevTools open via window size delta (heuristic).
                // If detected, blank the page (only when not on login screen).
                try {
                  var threshold = 200;
                  var check = function() {
                    var wDiff = window.outerWidth - window.innerWidth;
                    var hDiff = window.outerHeight - window.innerHeight;
                    if (wDiff > threshold || hDiff > threshold) {
                      // DevTools likely open — wipe the DOM. The login screen
                      // (which is shown when locked) still shows the password
                      // input, but the dashboard content is hidden.
                      // We don't do this if the body has the 'login-active' class.
                      if (!document.body.classList.contains('login-active')) {
                        document.body.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100vh;color:#666;font-family:monospace">—</div>';
                      }
                    }
                  };
                  setInterval(check, 1000);
                } catch (e) {}
              })();
            `,
          }}
        />
      </head>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        <DevToolsBlocker />
        {children}
        <Sonner />
      </body>
    </html>
  );
}
