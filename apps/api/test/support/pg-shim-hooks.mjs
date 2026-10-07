// Module-resolution hook: `import 'pg-mem'` resolves to the real-PostgreSQL shim.
export async function resolve(specifier, context, next) {
  if (specifier === 'pg-mem') return { url: new URL('./pg-mem-shim.mjs', import.meta.url).href, shortCircuit: true };
  return next(specifier, context);
}
