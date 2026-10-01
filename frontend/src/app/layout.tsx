import type { Metadata } from 'next';
import localFont from 'next/font/local';
import { AppProvider } from '@/components/AppProvider';
import './globals.css';

const satoshi = localFont({
  src: [
    { path: '../fonts/Satoshi-400.woff2', weight: '400', style: 'normal' },
    { path: '../fonts/Satoshi-500.woff2', weight: '500', style: 'normal' },
    { path: '../fonts/Satoshi-700.woff2', weight: '700', style: 'normal' },
  ],
  variable: '--font-sans',
  display: 'swap',
});

const cascadiaMono = localFont({
  src: [
    { path: '../fonts/CascadiaMono-400.woff2', weight: '400', style: 'normal' },
    { path: '../fonts/CascadiaMono-700.woff2', weight: '700', style: 'normal' },
  ],
  variable: '--font-mono',
  display: 'swap',
});

// Landing page display + body faces (see src/fonts/SOURCES.txt).
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
  return <html lang="en"><body className={`${satoshi.variable} ${cascadiaMono.variable} ${insidia.variable} ${aeonik.variable}`}><AppProvider>{children}</AppProvider></body></html>;
}
