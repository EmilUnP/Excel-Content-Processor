import type { Metadata, Viewport } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';

const inter = Inter({ subsets: ['latin'] });

export const metadata: Metadata = {
  title: 'Excel Content Processor v3.4',
  description: 'AI-powered Excel and CSV content processing with translation and cleaning',
  keywords: ['Excel', 'CSV', 'AI', 'Translation', 'Data Processing'],
  authors: [{ name: 'Excel Content Processor Team' }],
  robots: 'index, follow',
  openGraph: {
    title: 'Excel Content Processor v3.4',
    description: 'AI-powered Excel and CSV content processing with translation and cleaning',
    type: 'website',
    locale: 'en_US',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Excel Content Processor v3.4',
    description: 'AI-powered Excel and CSV content processing with translation and cleaning',
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="h-full">
      <body className={`${inter.className} h-full antialiased`}>
        {children}
      </body>
    </html>
  );
}
