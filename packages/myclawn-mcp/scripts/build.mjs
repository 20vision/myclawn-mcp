// Bundles exactly the viem functions we use into dist/viem.mjs. Result: the published package has zero
// runtime dependencies (installs in about a second instead of pulling 80 MB) and its crypto code is
// pinned at build time by package-lock.json. No install scripts run on the user's machine.
import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync, cpSync, rmSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(join(root, 'dist'), { recursive: true });
const pkg = (n) => JSON.parse(readFileSync(join(root, 'node_modules', n, 'package.json'), 'utf8')).version;
await build({
  entryPoints: [join(root, 'src/viem-entry.mjs')],
  outfile: join(root, 'dist/viem.mjs'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  minifySyntax: true,
  legalComments: 'inline',
  treeShaking: true,
  logLevel: 'warning',
  banner: { js: `// Bundled from viem@${pkg('viem')} (MIT, https://github.com/wevm/viem) and its dependencies. Do not edit. See scripts/build.mjs.` },
});
// The MyClawn repo is private, so the plugin files travel inside the tarball (`npx myclawn-mcp plugin install`).
const plugin = join(root, '..', 'myclawn-plugin');
if (existsSync(plugin)) {
  rmSync(join(root, 'dist/plugin'), { recursive: true, force: true });
  cpSync(plugin, join(root, 'dist/plugin'), { recursive: true, filter: (p) => !/\/(test|node_modules|package\.json)$/.test(p) });
}
const size = readFileSync(join(root, 'dist/viem.mjs')).length;
writeFileSync(join(root, 'dist/BUILD.txt'), `viem@${pkg('viem')} bundled, ${size} bytes\n`);
