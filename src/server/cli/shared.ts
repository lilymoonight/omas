export function requireSingleBinary(command: string): string {
  const isBun = typeof (process.versions as any).bun === 'string';
  if (!isBun) {
    console.error(`${command}: this command only works from the single-binary build.`);
    console.error('  Run `npm run build` and use release/omas.');
    process.exit(2);
  }
  return process.execPath;
}
