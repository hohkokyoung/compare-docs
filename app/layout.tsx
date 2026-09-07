import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'SI / B-L Checker',
  description: 'Compare a shipping instruction against a draft bill of lading and surface every inconsistency.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
