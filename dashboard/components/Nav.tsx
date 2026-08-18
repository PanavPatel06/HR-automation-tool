'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

const LINKS = [
  { href: '/', label: 'Applicants' },
  { href: '/inbox', label: 'Inbox' },
  { href: '/templates', label: 'Templates' },
  { href: '/replies', label: 'Replies' },
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

export function Nav() {
  const path = usePathname();
  if (path === '/login') return null;

  return (
    <nav className="nav">
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
