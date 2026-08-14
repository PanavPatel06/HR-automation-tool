import './globals.css';
import type { Metadata } from 'next';
import { Nav } from '../components/Nav';

export const metadata: Metadata = {
  title: 'HR Automation',
  description: 'Hiring pipeline control dashboard',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="shell">
          <Nav />
          {children}
        </div>
      </body>
    </html>
  );
}
