import './globals.css';
import type { Metadata } from 'next';
import { Inter, Newsreader } from 'next/font/google';
import { Nav } from '../components/Nav';

const inter = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap' });
// The one italic accent face — DESIGN.md's "Aave Aguzzo" role (one or two
// words per h1, in italic, purple). Aguzzo itself is Aave's own brand asset;
// this is a freely-licensed lookalike, loaded only for its italic weight.
const accent = Newsreader({ subsets: ['latin'], style: ['italic'], weight: ['500'], variable: '--font-accent', display: 'swap' });

export const metadata: Metadata = {
  title: 'HR Automation',
  description: 'Hiring pipeline control dashboard',
};

// Applies a stored theme choice before the first paint, so a returning
// visitor never sees a flash of the wrong theme while React hydrates.
// Deliberately a raw blocking <script>, not next/script — it has to run
// before paint, synchronously, in that exact position in the HTML.
const THEME_INIT_SCRIPT = `try{var t=localStorage.getItem('hr-theme');if(t==='light'||t==='dark')document.documentElement.setAttribute('data-theme',t);}catch(e){}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${accent.variable}`} suppressHydrationWarning>
      <body>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        <div className="shell">
          <Nav />
          {children}
        </div>
      </body>
    </html>
  );
}
