'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef } from 'react';

// Applicants, Inbox, and Replies used to be three separate pages; they're
// now one merged view at "/" (components/MailView.tsx) — the pipeline table,
// the per-candidate thread/compose view, and reply triage (a reply is
// cleared the moment you respond to it from the thread), all in one place.
const LINKS = [
  { href: '/', label: 'Inbox' },
  { href: '/templates', label: 'Templates' },
  { href: '/console', label: 'Console' },
  { href: '/settings', label: 'Settings' },
];

const THEME_KEY = 'hr-theme';

/**
 * No React state on purpose: the button's markup (both icons, one hidden by
 * CSS) is identical on the server and the client, so there is nothing for
 * hydration to disagree about. The click handler just flips a DOM attribute
 * and CSS does the rest — see the .theme-toggle rules in globals.css and the
 * inline script in layout.tsx that applies a stored choice before paint.
 */
function toggleTheme() {
  const root = document.documentElement;
  const current = root.dataset.theme || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  const next = current === 'dark' ? 'light' : 'dark';
  root.dataset.theme = next;
  try { localStorage.setItem(THEME_KEY, next); } catch { /* storage unavailable — theme just won't persist */ }
}

/**
 * The one loose nod to DESIGN.md §5a's WebGL fluid-sim background — a plain
 * 2D canvas, no shader, no simulation: two soft radial gradients drifting
 * slowly, drawn at a small intrinsic size and blurred via CSS (see
 * .nav-ambient in globals.css) — the same "render tiny, upscale, blur" trick
 * §5a documents, without a shader. Draws exactly one static frame and never
 * starts the loop under prefers-reduced-motion (§7c: the reference's own
 * strongest result), and stops the loop entirely — not just the drawing —
 * while the tab is hidden.
 */
function NavAmbient() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;

    const W = 200, H = 60;
    canvas.width = W;
    canvas.height = H;

    function draw(t: number) {
      ctx!.clearRect(0, 0, W, H);
      const blobs = [
        { x: W * 0.3 + Math.sin(t / 5200) * W * 0.15, y: H * 0.5 + Math.cos(t / 6100) * H * 0.3, r: W * 0.45, c: 'rgba(163,148,255,0.9)' },
        { x: W * 0.7 + Math.cos(t / 4700) * W * 0.15, y: H * 0.5 + Math.sin(t / 5900) * H * 0.3, r: W * 0.4, c: 'rgba(109,79,224,0.7)' },
      ];
      for (const b of blobs) {
        const g = ctx!.createRadialGradient(b.x, b.y, 0, b.x, b.y, b.r);
        g.addColorStop(0, b.c);
        g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx!.fillStyle = g;
        ctx!.fillRect(0, 0, W, H);
      }
    }

    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      draw(0);
      return;
    }

    let raf = 0;
    const loop = (t: number) => { draw(t); raf = requestAnimationFrame(loop); };
    const start = () => { raf = requestAnimationFrame(loop); };
    const stop = () => cancelAnimationFrame(raf);
    const onVisibility = () => (document.hidden ? stop() : start());

    if (!document.hidden) start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  return <canvas ref={ref} className="nav-ambient" aria-hidden="true" />;
}

export function Nav() {
  const path = usePathname();
  if (path === '/login') return null;

  return (
    <nav className="nav">
      <NavAmbient />
      <span className="brand">HR Automation</span>
      {LINKS.map((l) => (
        <Link key={l.href} href={l.href} className={path === l.href ? 'active' : ''}>
          {l.label}
        </Link>
      ))}
      <span className="spacer" />
      <button type="button" className="theme-toggle" onClick={toggleTheme} aria-label="Toggle light / dark theme">
        <span className="theme-icon-light" aria-hidden="true">☀</span>
        <span className="theme-icon-dark" aria-hidden="true">☾</span>
      </button>
      <form action="/api/logout" method="post">
        <button className="ghost sm" type="submit">Sign out</button>
      </form>
    </nav>
  );
}
