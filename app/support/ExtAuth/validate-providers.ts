export function validateExternalAuthProviders(
  providers: readonly { id: string; adapter: string }[],
  env: string | undefined,
): void {
  if (env === 'test') {
    return;
  }

  for (const provider of providers) {
    if (provider.adapter === 'test') {
      throw new Error(`Test authentication provider '${provider.id}' is disabled outside tests`);
    }
  }
}
