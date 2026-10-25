import type { ReactNode } from 'react';

export const metadata = {
  title: 'app-agent — Next.js example',
  description: 'Minimal demo of @ajc-dev/app-agent inside a Next.js App Router project.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, padding: 24 }}>{children}</body>
    </html>
  );
}
