/**
 * Entry point for the EDI 837 RAG server.
 *
 * Boots the vector database, seeds the 837 knowledge base, vendors the
 * React UMD bundles, and starts the HTTP API.
 */

import { boot } from './src/server';

boot().catch((err: unknown) => {
  console.error('Fatal: failed to start server:', err);
  process.exit(1);
});
