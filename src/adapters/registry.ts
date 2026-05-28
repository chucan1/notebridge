import type { SourceAdapter, DestinationAdapter } from "./interfaces";

const sourceAdapters = new Map<string, SourceAdapter>();
const destinationAdapters = new Map<string, DestinationAdapter>();

export function registerSource(adapter: SourceAdapter): void {
  if (sourceAdapters.has(adapter.platform)) {
    throw new Error(
      `Source adapter for "${adapter.platform}" already registered (${adapter.platform} v${adapter.version})`,
    );
  }
  sourceAdapters.set(adapter.platform, adapter);
}

export function registerDestination(adapter: DestinationAdapter): void {
  if (destinationAdapters.has(adapter.platform)) {
    throw new Error(
      `Destination adapter for "${adapter.platform}" already registered (${adapter.platform} v${adapter.version})`,
    );
  }
  destinationAdapters.set(adapter.platform, adapter);
}

export function getSourceAdapter(platform: string): SourceAdapter {
  const a = sourceAdapters.get(platform);
  if (!a) {
    throw new Error(
      `No source adapter for "${platform}". Available: [${[...sourceAdapters.keys()].join(", ")}]`,
    );
  }
  return a;
}

export function getDestinationAdapter(platform: string): DestinationAdapter {
  const a = destinationAdapters.get(platform);
  if (!a) {
    throw new Error(
      `No destination adapter for "${platform}". Available: [${[...destinationAdapters.keys()].join(", ")}]`,
    );
  }
  return a;
}

export function listSourcePlatforms(): string[] {
  return [...sourceAdapters.keys()];
}

export function listDestinationPlatforms(): string[] {
  return [...destinationAdapters.keys()];
}
