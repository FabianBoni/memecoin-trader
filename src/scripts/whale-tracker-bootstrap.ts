type WarningWithCode = Error & { code?: string };

const originalEmitWarning = process.emitWarning.bind(process) as (warning: string | Error, ...args: unknown[]) => void;

process.emitWarning = ((warning: string | Error, ...args: unknown[]) => {
  const warningType = typeof args[0] === 'string' ? args[0] : undefined;
  const warningCode = typeof args[1] === 'string'
    ? args[1]
    : (warning instanceof Error && typeof (warning as WarningWithCode).code === 'string' ? (warning as WarningWithCode).code : undefined);

  const isPunycodeDeprecation = warningCode === 'DEP0040'
    || (warningType === 'DeprecationWarning'
      && typeof warning === 'string'
      && warning.includes('The `punycode` module is deprecated'));

  if (isPunycodeDeprecation) {
    return;
  }

  originalEmitWarning(warning, ...args);
}) as typeof process.emitWarning;

await import(new URL('./whale-tracker.ts', import.meta.url).href);