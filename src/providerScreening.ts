import type { ScreeningProviderExtension } from "./core/screening/types.js";

// Optional provider-specific screening implementations are installed here.
// The starter repository intentionally bundles no vendor or policy.
export const providerScreeningExtensions: ScreeningProviderExtension[] = [];

export async function installProviderScreening(): Promise<void> {}

export function startProviderScreeningWorkers(): Array<() => void | Promise<void>> {
  return [];
}

export function registerProviderScreeningProtectedData(): void {}
