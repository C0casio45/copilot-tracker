import * as fs from "fs/promises";
import * as path from "path";
import { toDateKey } from "./github";
import { LocalDayActivity } from "./types";

/**
 * Reconstruit l'activité Copilot Chat (discussions, agents, modèles) en lisant
 * les sessions de chat que VS Code persiste sur disque. Aucune API n'est
 * appelée : c'est le complément local de l'endpoint AIC.
 *
 * Deux formats coexistent :
 *  - ancien : un objet JSON complet par fichier (*.json) ;
 *  - actuel : un journal d'opérations (*.jsonl) — ligne 1 `{"kind":0,"v":{snapshot}}`,
 *    puis `{"kind":1,"k":[chemin],"v":...}` (affectation) et
 *    `{"kind":2,"k":[chemin],"v":[...]}` (ajout en fin de tableau).
 *
 * Emplacements scannés (dérivés du dossier User de l'instance courante) :
 *   <User>/workspaceStorage/<hash>/chatSessions/*.json{,l}
 *   <User>/globalStorage/emptyWindowChatSessions/*.json{,l}
 */

interface RawChatRequest {
  timestamp?: number;
  agent?: { id?: string; name?: string; fullName?: string };
  agentId?: string;
  modelId?: string;
  result?: { metadata?: { modelId?: string } };
  modeInfo?: {
    kind?: string;
    modeId?: string;
    modeName?: string;
    modeInstructions?: { name?: string };
  };
}

interface RawChatSession {
  creationDate?: number;
  lastMessageDate?: number;
  requests?: RawChatRequest[];
}

export interface ScanStats {
  filesSeen: number;
  filesInWindow: number;
  sessionsParsed: number;
  requestsCounted: number;
  scannedDirs: string[];
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
  // Un mode custom (agent défini par l'utilisateur) est l'info la plus parlante.
  const custom = req.modeInfo?.modeInstructions?.name;
  if (custom) return custom;
  if (req.modeInfo?.kind) return req.modeInfo.kind; // agent / ask / edit
  const id = req.agent?.id ?? req.agentId ?? "";
  if (id) {
    // "github.copilot.editsAgent" -> "editsAgent"
    const short = id.split(".").pop() ?? id;
    return short || id;
  }
  return req.agent?.name ?? req.agent?.fullName ?? "chat";
}

function parseSession(raw: RawChatSession): ParsedSession | undefined {
  const creationDate = typeof raw.creationDate === "number" ? raw.creationDate : undefined;
  if (creationDate === undefined || !Array.isArray(raw.requests)) return undefined;
  const requests = raw.requests
    .filter((r): r is RawChatRequest => !!r && typeof r === "object")
    .map((r) => ({
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

type Op = { kind: number; k?: (string | number)[]; v?: unknown };

function setPath(root: unknown, keys: (string | number)[], value: unknown): void {
  let node = root as Record<string | number, unknown>;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    if (node[key] === undefined || node[key] === null) {
      node[key] = typeof keys[i + 1] === "number" ? [] : {};
    }
    node = node[key] as Record<string | number, unknown>;
    if (typeof node !== "object") return;
  }
  node[keys[keys.length - 1]] = value;
}

function getPath(root: unknown, keys: (string | number)[]): unknown {
  let node: unknown = root;
  for (const key of keys) {
    if (node === null || typeof node !== "object") return undefined;
    node = (node as Record<string | number, unknown>)[key];
  }
  return node;
}

/** Rejoue le journal d'opérations d'un fichier .jsonl et rend le snapshot final. */
function replayJournal(content: string): RawChatSession | undefined {
  let root: RawChatSession | undefined;
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let op: Op;
    try {
      op = JSON.parse(trimmed) as Op;
    } catch {
      continue;
    }
    if (op.kind === 0) {
      root = op.v as RawChatSession;
    } else if (!root || !Array.isArray(op.k) || op.k.length === 0) {
      continue;
    } else if (op.kind === 1) {
      setPath(root, op.k, op.v);
    } else if (op.kind === 2) {
      const target = getPath(root, op.k);
      const items = Array.isArray(op.v) ? op.v : [op.v];
      if (Array.isArray(target)) {
        target.push(...items);
      } else if (target === undefined) {
        setPath(root, op.k, [...items]);
      }
    }
    // kinds inconnus : ignorés (format défensif)
  }
  return root;
}

function isSessionFile(name: string): boolean {
  return name.endsWith(".json") || name.endsWith(".jsonl");
}

async function listSessionFiles(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && isSessionFile(e.name))
      .map((e) => path.join(dir, e.name));
  } catch {
    return [];
  }
}

async function collectSessionFiles(userDir: string): Promise<{ files: string[]; dirs: string[] }> {
  const files: string[] = [];
  const dirs: string[] = [];
  const addDir = async (dir: string) => {
    const found = await listSessionFiles(dir);
    if (found.length) dirs.push(dir);
    files.push(...found);
  };
  await addDir(path.join(userDir, "globalStorage", "emptyWindowChatSessions"));
  const wsRoot = path.join(userDir, "workspaceStorage");
  let wsDirs: string[] = [];
  try {
    const entries = await fs.readdir(wsRoot, { withFileTypes: true });
    wsDirs = entries.filter((e) => e.isDirectory()).map((e) => path.join(wsRoot, e.name));
  } catch {
    /* pas de workspaceStorage */
  }
  for (const ws of wsDirs) {
    await addDir(path.join(ws, "chatSessions"));
  }
  return { files, dirs };
}

/**
 * @param userDir dossier "User" de VS Code (parent de globalStorage)
 * @param sinceMs ne prend en compte que l'activité postérieure à ce timestamp
 */
export async function scanLocalActivity(
  userDir: string,
  sinceMs: number
): Promise<{ days: Map<string, LocalDayActivity>; stats: ScanStats }> {
  const days = new Map<string, LocalDayActivity>();
  const getDay = (key: string): LocalDayActivity => {
    let d = days.get(key);
    if (!d) {
      d = { date: key, sessionsStarted: 0, requests: 0, agents: {}, models: {} };
      days.set(key, d);
    }
    return d;
  };

  const { files, dirs } = await collectSessionFiles(userDir);
  const stats: ScanStats = {
    filesSeen: files.length,
    filesInWindow: 0,
    sessionsParsed: 0,
    requestsCounted: 0,
    scannedDirs: dirs,
  };

  for (const file of files) {
    let stat;
    try {
      stat = await fs.stat(file);
    } catch {
      continue;
    }
    // Fichier plus vieux que la fenêtre d'historique : aucune activité pertinente.
    if (stat.mtimeMs < sinceMs) continue;
    stats.filesInWindow++;

    let cached = fileCache.get(file);
    if (!cached || cached.mtimeMs !== stat.mtimeMs) {
      let session: ParsedSession | undefined;
      try {
        const content = await fs.readFile(file, "utf8");
        const raw = file.endsWith(".jsonl")
          ? replayJournal(content)
          : (JSON.parse(content) as RawChatSession);
        session = raw ? parseSession(raw) : undefined;
      } catch {
        session = undefined;
      }
      cached = { mtimeMs: stat.mtimeMs, session };
      fileCache.set(file, cached);
    }
    const session = cached.session;
    if (!session) continue;
    stats.sessionsParsed++;

    if (session.creationDate >= sinceMs) {
      getDay(toDateKey(new Date(session.creationDate))).sessionsStarted++;
    }
    for (const req of session.requests) {
      if (req.timestamp < sinceMs) continue;
      const day = getDay(toDateKey(new Date(req.timestamp)));
      day.requests++;
      stats.requestsCounted++;
      day.agents[req.agent] = (day.agents[req.agent] ?? 0) + 1;
      if (req.model) {
        day.models[req.model] = (day.models[req.model] ?? 0) + 1;
      }
    }
  }
  return { days, stats };
}
