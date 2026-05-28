import type { NoteIR, Resource, PlatformConfig, WriteOptions, TransferResult } from "../ir/schema";

export interface SourceAdapter {
  readonly platform: string;
  readonly version: string;

  healthCheck(config: PlatformConfig): Promise<boolean>;

  listResources(config: PlatformConfig): Promise<Resource[]>;

  fetch(resource: Resource, config: PlatformConfig): Promise<NoteIR[]>;

  fetchIncremental?(
    resource: Resource,
    since: Date,
    config: PlatformConfig,
  ): Promise<NoteIR[]>;
}

export interface DestinationAdapter {
  readonly platform: string;
  readonly version: string;

  healthCheck(config: PlatformConfig): Promise<boolean>;

  write(
    notes: NoteIR[],
    config: PlatformConfig,
    options?: WriteOptions,
  ): Promise<TransferResult>;
}
