/**
 * Copy h5wasm/node distribution files to the out/ directory.
 *
 * Since h5wasm is marked as external in esbuild (its Node.js build includes
 * a 4MB embedded WASM binary that shouldn't be re-bundled), we need to
 * copy the h5wasm package to a location where the bundled extension can
 * find it at runtime via `import('h5wasm/node')`.
 *
 * This script copies the h5wasm package into out/node_modules/h5wasm/
 * so that Node.js module resolution finds it relative to out/main.js.
 */

import { cpSync, mkdirSync, rmSync, existsSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');

// Find h5wasm package location
let h5wasmPkgPath;

// Check direct node_modules first (pnpm may create a symlink here)
const directPath = join(projectRoot, 'node_modules', 'h5wasm');
if (existsSync(directPath)) {
  // Resolve symlink to real path
  h5wasmPkgPath = realpathSync(directPath);
} else {
  // Search pnpm store
  const pnpmDir = join(projectRoot, 'node_modules', '.pnpm');
  const entries = readdirSync(pnpmDir);
  const h5wasmEntry = entries.find((e) => e.startsWith('h5wasm@'));
  if (!h5wasmEntry) {
    throw new Error('Could not find h5wasm in node_modules');
  }
  h5wasmPkgPath = realpathSync(
    join(pnpmDir, h5wasmEntry, 'node_modules', 'h5wasm'),
  );
}

const targetDir = join(projectRoot, 'out', 'node_modules', 'h5wasm');

// Clean target first
if (existsSync(targetDir)) {
  rmSync(targetDir, { recursive: true });
}

// Copy with dereference to follow symlinks
mkdirSync(dirname(targetDir), { recursive: true });
cpSync(h5wasmPkgPath, targetDir, { recursive: true, dereference: true });

console.log(`Copied h5wasm from ${h5wasmPkgPath} to ${targetDir}`);

// Verify the copy
const nodeDir = join(targetDir, 'dist', 'node');
if (existsSync(nodeDir)) {
  console.log(`  Node.js build files: ${readdirSync(nodeDir).join(', ')}`);
} else {
  console.error('  WARNING: dist/node/ not found in copied h5wasm!');
}
