import { registerSource, registerDestination } from "../adapters/registry";
import { wereadReader } from "../adapters/weread-reader";
import { flomoReader } from "../adapters/flomo-reader";
import { getnoteWriter } from "../adapters/getnote-writer";
import { flomoWriter } from "../adapters/flomo-writer";
import { obsidianWriter } from "../adapters/obsidian-writer";
import { localMarkdownReader } from "../adapters/local-markdown-reader";

export function bootstrap(): void {
  registerSource(wereadReader);
  registerSource(flomoReader);
  registerSource(localMarkdownReader);
  registerDestination(getnoteWriter);
  registerDestination(flomoWriter);
  registerDestination(obsidianWriter);
}
