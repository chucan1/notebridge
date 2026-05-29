import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

const CONFIG_DIR = join(homedir(), ".notebridge");
const CONFIG_FILE = join(CONFIG_DIR, "config.yml");

interface NotebridgeConfig {
  credentials?: {
    flomo?: { authorization?: string };
    weread?: { api_key?: string };
    getnote?: { api_key?: string };
    obsidian?: { vault_path?: string };
  };
}

let cachedConfig: NotebridgeConfig | null = null;

function parseYaml(text: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  let currentKey = "";
  for (const line of text.split("\n")) {
    if (line.trim().startsWith("#") || line.trim() === "") continue;
    const indent = line.search(/\S/);
    if (indent < 2) {
      const match = line.match(/^(\w[\w_-]*):\s*(.*)$/);
      if (match) {
        currentKey = match[1];
        const val = match[2].trim();
        if (val) {
          result[`${currentKey}`] = val.replace(/^["']|["']$/g, "");
        } else {
          result[`${currentKey}`] = {};
        }
      }
    } else if (indent >= 2 && currentKey) {
      const match = line.match(/^\s+(\w[\w_-]*):\s*(.*)$/);
      if (match && typeof result[currentKey] === "object") {
        (result[currentKey] as Record<string, string>)[match[1]] = match[2].trim().replace(/^["']|["']$/g, "");
      }
    }
  }
  return result;
}

function parseYaml2(text: string): NotebridgeConfig {
  const raw = parseYaml(text);
  const creds = raw["credentials"] as Record<string, Record<string, string>> | undefined;
  return {
    credentials: {
      flomo: creds?.["flomo"] ? { authorization: creds["flomo"]["authorization"] } : undefined,
      weread: creds?.["weread"] ? { api_key: creds["weread"]["api_key"] } : undefined,
    },
  };
}

export async function loadConfig(): Promise<NotebridgeConfig> {
  if (cachedConfig) return cachedConfig;
  try {
    const text = await readFile(CONFIG_FILE, "utf-8");
    cachedConfig = parseYaml2(text);
  } catch {
    cachedConfig = {};
  }
  return cachedConfig!;
}

export async function saveFlomoToken(authToken: string): Promise<void> {
  const config = await loadConfig();
  if (!config.credentials) config.credentials = {};
  if (!config.credentials.flomo) config.credentials.flomo = {};
  config.credentials.flomo.authorization = authToken;

  const yml = `# notebridge config — auto-generated
credentials:
  flomo:
    authorization: "${authToken}"
`;

  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(CONFIG_FILE, yml, "utf-8");
  cachedConfig = null; // clear cache
}

export function getConfigFilePath(): string {
  return CONFIG_FILE;
}
