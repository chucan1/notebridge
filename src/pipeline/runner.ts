import type { SourceAdapter, DestinationAdapter } from "../adapters/interfaces";
import type {
  NoteIR,
  Resource,
  PlatformConfig,
  TransferResult,
  TransferError,
  RunOptions,
  GroupingMode,
} from "../ir/schema";
import { validateIRVersion } from "../ir/schema";

const RETRY_DELAYS_MS = [1000, 2000, 4000];

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function groupNotes(notes: NoteIR[], mode: GroupingMode): NoteIR[] {
  if (mode === "per_item") return notes;
  if (mode === "per_book") {
    const groups = new Map<string, NoteIR[]>();
    for (const n of notes) {
      const key = `${n.source}:${n.book_title ?? "unknown"}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(n);
    }
    return [...groups.values()].map((group) => mergeGroup(group));
  }
  if (mode === "per_chapter") {
    const groups = new Map<string, NoteIR[]>();
    for (const n of notes) {
      const key = `${n.source}:${n.book_title}:${n.chapter_title ?? "unknown"}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(n);
    }
    return [...groups.values()].map((group) => mergeGroup(group));
  }
  return notes;
}

function mergeGroup(group: NoteIR[]): NoteIR {
  if (group.length <= 1) return group[0];
  const first = group[0];
  const mergedContent = group
    .map((n) => n.content)
    .join("\n\n---\n\n");
  return {
    ...first,
    content_type: "mixed",
    content: mergedContent,
    children: group.flatMap((n) => n.children),
    tags: [...new Set(group.flatMap((n) => n.tags))],
  };
}

async function writeWithRetry(
  dest: DestinationAdapter,
  notes: NoteIR[],
  config: PlatformConfig,
  options: RunOptions | undefined,
): Promise<TransferResult> {
  let result = await dest.write(notes, config, options);

  const failedNotes = result.errors.map((e) => e.source_note_id);
  if (failedNotes.length === 0) return result;

  const toRetry = notes.filter((n) => failedNotes.includes(n.source_note_id));
  if (toRetry.length === 0) return result;

  for (let attempt = 0; attempt < RETRY_DELAYS_MS.length; attempt++) {
    await sleep(RETRY_DELAYS_MS[attempt]);
    const retryResult = await dest.write(toRetry, config, options);

    result = {
      ...result,
      notes_transferred: result.notes_transferred + retryResult.notes_transferred,
      notes_skipped: result.notes_skipped + retryResult.notes_skipped,
      errors: [
        ...result.errors.filter(
          (e) => !retryResult.errors.some((re) => re.source_note_id === e.source_note_id),
        ),
        ...retryResult.errors,
      ],
    };

    if (retryResult.errors.length === 0) break;
  }

  return result;
}

export async function run(
  source: SourceAdapter,
  destination: DestinationAdapter,
  resource: Resource,
  sourceConfig: PlatformConfig,
  destConfig: PlatformConfig,
  options?: RunOptions,
): Promise<TransferResult> {
  // 1. Health checks
  const sourceOk = await source.healthCheck(sourceConfig);
  if (!sourceOk) {
    return {
      source: source.platform,
      target: destination.platform,
      notes_transferred: 0,
      notes_skipped: 0,
      errors: [
        {
          source_note_id: "",
          reason: "auth_expired",
          detail: `Source health check failed: ${source.platform}`,
        },
      ],
    };
  }

  const destOk = await destination.healthCheck(destConfig);
  if (!destOk) {
    return {
      source: source.platform,
      target: destination.platform,
      notes_transferred: 0,
      notes_skipped: 0,
      errors: [
        {
          source_note_id: "",
          reason: "auth_expired",
          detail: `Destination health check failed: ${destination.platform}`,
        },
      ],
    };
  }

  // 2. Fetch source notes
  let notes: NoteIR[];
  try {
    if (options?.incremental && source.fetchIncremental) {
      notes = await source.fetchIncremental(resource, new Date(), sourceConfig);
    } else {
      notes = await source.fetch(resource, sourceConfig);
    }
  } catch (err) {
    return {
      source: source.platform,
      target: destination.platform,
      notes_transferred: 0,
      notes_skipped: 0,
      errors: [
        {
          source_note_id: "",
          reason: "fetch_failed",
          detail: err instanceof Error ? err.message : String(err),
        },
      ],
    };
  }

  // 3. Validate IR versions
  for (const n of notes) {
    validateIRVersion(n.ir_version);
  }

  // 4. Apply grouping
  const grouping = options?.grouping ?? "per_item";
  const processedNotes = groupNotes(notes, grouping);

  // 5. Write with retry
  return writeWithRetry(destination, processedNotes, destConfig, options);
}
