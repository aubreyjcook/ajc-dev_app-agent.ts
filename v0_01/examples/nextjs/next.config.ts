import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

// Nothing special is required to use the agent library. The one setting here
// exists because this example lives *inside* the library repo: Next.js sees
// two lockfiles (ours and the library's) and warns about which one is the
// project root. Pinning the root to this directory silences that. You will
// not need it in a normal standalone app.
const nextConfig: NextConfig = {
  outputFileTracingRoot: path.dirname(fileURLToPath(import.meta.url)),
};

export default nextConfig;
