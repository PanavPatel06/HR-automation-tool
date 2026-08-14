'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

const LINKS = [
  { href: '/', label: 'Applicants' },
  { href: '/templates', label: 'Templates' },
  { href: '/replies', label: 'Replies' },
  { href: '/console', label: 'Console' },
  { href: '/settings', label: 'Settings' },
];

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
      <form action="/api/logout" method="post">
        <button className="ghost sm" type="submit">Sign out</button>
      </form>
    </nav>
  );
}
