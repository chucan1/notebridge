import { registerSource, registerDestination } from "../adapters/registry";
import { wereadReader } from "../adapters/weread-reader";
import { getnoteWriter } from "../adapters/getnote-writer";
import { obsidianWriter } from "../adapters/obsidian-writer";
import { localMarkdownReader } from "../adapters/local-markdown-reader";

export function bootstrap(): void {
  registerSource(wereadReader);
  registerSource(localMarkdownReader);
  registerDestination(getnoteWriter);
  registerDestination(obsidianWriter);
}
