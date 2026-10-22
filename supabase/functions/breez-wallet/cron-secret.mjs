/**
 * Prefer a dedicated cron credential when configured.
 * An explicitly empty override must fail closed, never use the fallback.
 * @param {(name: string) => string | undefined} getEnv
 * @param {string} scope
 * @returns {string}
 */
export function configuredCronSecret(getEnv, scope) {
  const dedicated = getEnv(scope);
  return dedicated === undefined ? (getEnv("CRON_SECRET") ?? "") : dedicated;
}
