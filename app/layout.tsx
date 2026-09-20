import './globals.css';
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'SnakeBench', description: 'How fast can a model decide?' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
