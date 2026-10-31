#!/usr/bin/env node
// Entry point: `vcf-automation-mcp setup ...` runs the one-time service account setup,
// anything else starts the MCP server on stdio.
if (process.argv[2] === 'setup') {
  const { runSetup } = await import('./setup.js');
  try {
    await runSetup(process.argv.slice(3));
    process.exitCode = 0;
  } catch (e: any) {
    console.error(`\nSetup failed: ${e?.message ?? e}`);
    process.exitCode = 1;
  }
  // exit on the next tick: exiting while the terminal handle is still closing crashes libuv on Windows
  setTimeout(() => process.exit(process.exitCode ?? 0), 100);
} else {
  await import('./index.js');
}
