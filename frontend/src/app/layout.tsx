import type { Metadata } from 'next';
import localFont from 'next/font/local';
import { AppProvider } from '@/components/AppProvider';
import './globals.css';

// The only two faces: Insidia for display, Aeonik Pro for everything else
// (see src/fonts/SOURCES.txt).
const insidia = localFont({
  src: [{ path: '../fonts/Insidia.otf', weight: '400', style: 'normal' }],
  variable: '--font-insidia',
  display: 'swap',
});

const aeonik = localFont({
  src: [
    { path: '../fonts/AeonikPro-Light.otf', weight: '300', style: 'normal' },
    { path: '../fonts/AeonikPro-Regular.otf', weight: '400', style: 'normal' },
    { path: '../fonts/AeonikPro-Medium.otf', weight: '500', style: 'normal' },
    { path: '../fonts/AeonikPro-Bold.otf', weight: '700', style: 'normal' },
    { path: '../fonts/AeonikPro-Black.otf', weight: '900', style: 'normal' },
  ],
  variable: '--font-aeonik',
  display: 'swap',
});

export const metadata: Metadata = { title: 'Cult | Trade with your cult', description: 'Trading cults on Monad.' };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  // Extensions such as Grammarly add attributes to <html>/<body> before React
  // hydrates; ignore those (this only covers these two tags' own attributes).
  return <html lang="en" suppressHydrationWarning><body suppressHydrationWarning className={`${insidia.variable} ${aeonik.variable}`}><AppProvider>{children}</AppProvider></body></html>;
}
