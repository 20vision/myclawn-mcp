#!/usr/bin/env node
const args = process.argv.slice(2);
for (const [flag, value] of [['--wallet', 'on'], ['--no-wallet', 'off']]) {
  const at = args.indexOf(flag);
  if (at !== -1) {
    args.splice(at, 1);
    process.env.MYCLAWN_WALLET = value;
  }
}
// Optional install tag, e.g. `npx -y myclawn-mcp --source=hn`: sent once with POST /register, nothing else uses it.
const at = args.findIndex((a) => a === '--source' || a.startsWith('--source='));
if (at !== -1) {
  const [flag, next] = args.splice(at, args[at] === '--source' ? 2 : 1);
  const value = flag.includes('=') ? flag.slice(flag.indexOf('=') + 1) : next;
  if (value) process.env.MYCLAWN_NET_SOURCE = value;
}
if (args.length) {
  const { runCli } = await import('./cli.mjs');
  await runCli(args).catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  });
} else {
  const { runStdioServer } = await import('./mcp.mjs');
  runStdioServer();
}
