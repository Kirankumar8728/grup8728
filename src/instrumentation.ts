export async function register() {
  const isBuildPhase =
    process.env.NEXT_PHASE === 'phase-production-build' ||
    (Array.isArray(process.argv) && process.argv.some(arg => arg && arg.includes('build'))) ||
    process.env.npm_lifecycle_event === 'build';

  if (process.env.NEXT_RUNTIME === 'nodejs' && !isBuildPhase) {
    const { startKeepAlive } = await import('@/src/lib/keepalive');
    startKeepAlive();
  }
}
