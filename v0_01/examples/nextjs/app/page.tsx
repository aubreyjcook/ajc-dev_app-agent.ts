import { Chat } from '@/components/Chat';

// A Server Component (the default in the App Router). It renders static
// markup and mounts the interactive <Chat /> client component.
export default function HomePage() {
  return (
    <main>
      <h1 style={{ fontFamily: 'system-ui, sans-serif', textAlign: 'center' }}>app-agent demo</h1>
      <Chat />
    </main>
  );
}
