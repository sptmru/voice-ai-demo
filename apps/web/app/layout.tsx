import type { Metadata } from 'next';
import '@fontsource-variable/dm-sans';
import '@fontsource-variable/manrope';
import './globals.css';
export const metadata: Metadata = {
  title: 'Relay — Voice AI Support Engineer',
  description: 'An observable support workspace. Real tools, grounded answers, and a human when it matters.',
};
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
