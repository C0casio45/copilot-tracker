import * as fs from "fs/promises";
import * as path from "path";
import { toDateKey } from "./github";
import { LocalDayActivity } from "./types";

/**
 * Reconstruit l'activité Copilot Chat (discussions, agents, modèles) en lisant
 * les sessions de chat que VS Code persiste sur disque. Aucune API n'est
 * appelée : c'est le complément local de l'endpoint AIC.
 *
 * Emplacements scannés (dérivés du dossier User de l'instance courante) :
 *   <User>/workspaceStorage/<hash>/chatSessions/*.json
 *   <User>/workspaceStorage/<hash>/chatEditingSessions/*.json
 *   <User>/globalStorage/emptyWindowChatSessions/*.json
 */

interface RawChatRequest {
  timestamp?: number;
  agent?: { id?: string; name?: string; fullName?: string };
  agentId?: string;
  modelId?: string;
  result?: { metadata?: { modelId?: string } };
}

interface RawChatSession {
  creationDate?: number;
  lastMessageDate?: number;
  customTitle?: string;
  requests?: RawChatRequest[];
}

/** Cache de parse par fichier (chemin -> mtime + contribution). */
interface CachedFile {
  mtimeMs: number;
  session: ParsedSession | undefined;
}

interface ParsedSession {
  creationDate: number;
  requests: { timestamp: number; agent: string; model?: string }[];
}

const fileCache = new Map<string, CachedFile>();

function agentLabel(req: RawChatRequest): string {
  const id = req.agent?.id ?? req.agentId ?? "";
  const name = req.agent?.fullName ?? req.agent?.name ?? "";
  if (name) return name;
  if (id) {
    // "github.copilot.default" -> "default"
    const short = id.split(".").pop() ?? id;
    return short || id;
  }
  return "chat";
}

function parseSession(raw: RawChatSession): ParsedSession | undefined {
  const creationDate = typeof raw.creationDate === "number" ? raw.creationDate : undefined;
  if (creationDate === undefined || !Array.isArray(raw.requests)) return undefined;
  const requests = raw.requests.map((r) => ({
    timestamp:
      typeof r.timestamp === "number"
        ? r.timestamp
        : typeof raw.lastMessageDate === "number"
          ? raw.lastMessageDate
          : creationDate,
    agent: agentLabel(r),
    model: r.modelId ?? r.result?.metadata?.modelId,
  }));
  return { creationDate, requests };
}

async function listJsonFiles(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && e.name.endsWith(".json"))
      .map((e) => path.join(dir, e.name));
  } catch {
    return [];
  }
}

async function collectSessionFiles(userDir: string): Promise<string[]> {
  const files: string[] = [];
  files.push(...(await listJsonFiles(path.join(userDir, "globalStorage", "emptyWindowChatSessions"))));
  const wsRoot = path.join(userDir, "workspaceStorage");
  let wsDirs: string[] = [];
  try {
    const entries = await fs.readdir(wsRoot, { withFileTypes: true });
    wsDirs = entries.filter((e) => e.isDirectory()).map((e) => path.join(wsRoot, e.name));
  } catch {
    /* pas de workspaceStorage */
  }
  for (const ws of wsDirs) {
    files.push(...(await listJsonFiles(path.join(ws, "chatSessions"))));
    files.push(...(await listJsonFiles(path.join(ws, "chatEditingSessions"))));
  }
  return files;
}

/**
 * @param userDir dossier "User" de VS Code (parent de globalStorage)
 * @param sinceMs ne prend en compte que l'activité postérieure à ce timestamp
 */
export async function scanLocalActivity(
  userDir: string,
  sinceMs: number
): Promise<Map<string, LocalDayActivity>> {
  const days = new Map<string, LocalDayActivity>();
  const getDay = (key: string): LocalDayActivity => {
    let d = days.get(key);
    if (!d) {
      d = { date: key, sessionsStarted: 0, requests: 0, agents: {}, models: {} };
      days.set(key, d);
    }
    return d;
  };

  const files = await collectSessionFiles(userDir);
  for (const file of files) {
    let stat;
    try {
      stat = await fs.stat(file);
    } catch {
      continue;
    }
    // Fichier plus vieux que la fenêtre d'historique : aucune activité pertinente.
    if (stat.mtimeMs < sinceMs) continue;

    let cached = fileCache.get(file);
    if (!cached || cached.mtimeMs !== stat.mtimeMs) {
      let session: ParsedSession | undefined;
      try {
        const raw = JSON.parse(await fs.readFile(file, "utf8")) as RawChatSession;
        session = parseSession(raw);
      } catch {
        session = undefined;
      }
      cached = { mtimeMs: stat.mtimeMs, session };
      fileCache.set(file, cached);
    }
    const session = cached.session;
    if (!session) continue;

    if (session.creationDate >= sinceMs) {
      getDay(toDateKey(new Date(session.creationDate))).sessionsStarted++;
    }
    for (const req of session.requests) {
      if (req.timestamp < sinceMs) continue;
      const day = getDay(toDateKey(new Date(req.timestamp)));
      day.requests++;
      day.agents[req.agent] = (day.agents[req.agent] ?? 0) + 1;
      if (req.model) {
        day.models[req.model] = (day.models[req.model] ?? 0) + 1;
      }
    }
  }
  return days;
}
