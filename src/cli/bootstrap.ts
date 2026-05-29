import { registerSource, registerDestination } from "../adapters/registry";
import { wereadReader } from "../adapters/weread-reader";
import { flomoReader } from "../adapters/flomo-reader";
import { notionReader } from "../adapters/notion-reader";
import { getnoteWriter } from "../adapters/getnote-writer";
import { flomoWriter } from "../adapters/flomo-writer";
import { notionWriter } from "../adapters/notion-writer";
import { obsidianWriter } from "../adapters/obsidian-writer";
import { localMarkdownReader } from "../adapters/local-markdown-reader";
import { obsidianReader } from "../adapters/obsidian-reader";

export function bootstrap(): void {
  registerSource(wereadReader);
  registerSource(flomoReader);
  registerSource(notionReader);
  registerSource(obsidianReader);
  registerSource(localMarkdownReader);
  registerDestination(getnoteWriter);
  registerDestination(flomoWriter);
  registerDestination(notionWriter);
  registerDestination(obsidianWriter);
}
