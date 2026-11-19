import { createRootRoute, HeadContent, Outlet, Scripts } from '@tanstack/react-router';
import type { ReactNode } from 'react';

import { AppHeader } from '../UI/AppHeader';

import styles from '../styles.css?url';

/** Manrope for the text, IBM Plex Mono for the names of resources and requests. */
const fonts =
  'https://fonts.googleapis.com/css2?family=Manrope:wght@400..800&family=IBM+Plex+Mono:wght@400;500;600&display=swap';

const icon =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath d='M1 9h3l2-6 4 10 2-4h3' fill='none' stroke='%232457c5' stroke-width='2'/%3E%3C/svg%3E";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'Leads lab' },
    ],
    links: [
      { rel: 'preconnect', href: 'https://fonts.googleapis.com' },
      { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossOrigin: 'anonymous' },
      { rel: 'stylesheet', href: fonts },
      { rel: 'stylesheet', href: styles },
      { rel: 'icon', href: icon },
    ],
  }),
  shellComponent: RootDocument,
  component: App,
});

function App() {
  return (
    <>
      <AppHeader />
      <Outlet />
    </>
  );
}

function RootDocument({ children }: { readonly children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}
