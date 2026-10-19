#!/usr/bin/env node
// CI check (NFR-DAT-004): fail when source code uses the server's local-time date methods.
// Use the Asia/Manila helpers from ccms-shared (toManilaDate, fromManila, ...) or UTC methods
// (getUTCDay, setUTCHours, ...) instead. Add `// ccms-allow-local-time` on a line to exempt it.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const SKIP_DIRS = new Set(['node_modules', '.next', '.git', 'coverage', 'dist', 'build']);
const EXTENSIONS = new Set(['.js', '.jsx', '.mjs', '.cjs']);
// getDay/getDate/getHours/... and their setters, but not the getUTC*/setUTC* variants.
const LOCAL_TIME_METHOD = /\.(?:get|set)(?:Day|Date|Hours|Minutes|Seconds|Milliseconds|Month|FullYear|Year)\s*\(/;
const ALLOW = 'ccms-allow-local-time';

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const path = join(dir, name);
    const stats = statSync(path);
    if (stats.isDirectory()) yield* walk(path);
    else if (EXTENSIONS.has(extname(name))) yield path;
  }
}

export function findLocalTimeUsage(roots) {
  const findings = [];
  for (const root of roots) {
    const start = resolve(root);
    const files = statSync(start).isDirectory() ? walk(start) : [start];
    for (const file of files) {
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, index) => {
          if (LOCAL_TIME_METHOD.test(line) && !line.includes(ALLOW)) {
            findings.push({ file, line: index + 1, text: line.trim() });
          }
        });
    }
  }
  return findings;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('ccms-check-time')) {
  const roots = process.argv.slice(2);
  const findings = findLocalTimeUsage(roots.length ? roots : ['src']);
  if (findings.length) {
    console.error('Server-local date methods are not allowed (use Asia/Manila helpers or UTC methods):');
    for (const f of findings) console.error(`  ${f.file}:${f.line}  ${f.text}`);
    process.exit(1);
  }
  console.log('Time usage check passed: no server-local date methods found.');
}
