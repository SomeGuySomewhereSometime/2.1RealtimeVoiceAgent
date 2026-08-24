import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { appendFileSync, chmodSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import readline from "node:readline";

const HANDLE = /^[A-Za-z0-9_]{1,15}$/;
const ROOM_ID = /^[A-Za-z0-9_-]{3,100}$/;

export function normalizeXSpaceRoomId(value) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(candidate);
    if (/^(?:www\.)?(?:x|twitter)\.com$/i.test(url.hostname)) {
      const roomId = url.pathname.match(/^\/i\/spaces\/([^/?#]+)/i)?.[1];
      if (!roomId) throw new Error("O link não é de um X Space.");
      if (!ROOM_ID.test(roomId)) throw new Error("O identificador do X Space é inválido.");
      return roomId;
    }
  } catch (error) {
    if (trimmed.includes("/") || trimmed.includes(":")) throw error;
  }
  if (!ROOM_ID.test(trimmed)) throw new Error("O identificador do X Space é inválido.");
  return trimmed;
}

function firstExisting(paths) {
  return paths.find((path) => path && existsSync(path));
}

export function resolveXSpaceConfig(env, projectRoot) {
  const roomId = normalizeXSpaceRoomId(env.X_SPACE_ROOM_ID || env.KIKA_X_SPACE_ROOM_ID);
  const localPython = join(projectRoot, ".venv-xspace", "bin", "python");
  const codexVoicePython = resolve(projectRoot, "..", "CODEXVOICE", ".venv-xspace", "bin", "python");
  return {
    enabled: Boolean(roomId),
    roomId,
    cookiesFile: (env.X_COOKIES_FILE || env.KIKA_X_COOKIES_FILE || "").trim()
      || join(homedir(), ".config", "kika", "twitter.cookies"),
    python: (env.X_PYTHON || env.KIKA_X_PYTHON || "").trim()
      || firstExisting([localPython, codexVoicePython]) || "python3",
    selfHandle: String(env.X_SELF_HANDLE || "mira_theagent").replace(/^@/, "").toLowerCase(),
    ownerHandle: String(env.X_OWNER_HANDLE || "").replace(/^@/, "").toLowerCase(),
    projectRoot,
  };
}

export function parseXSpaceCaption(value) {
  if (!value || typeof value !== "object") return null;
  const eventId = typeof value.eventId === "string" ? value.eventId : "";
  const handle = typeof value.handle === "string" ? value.handle.replace(/^@/, "").toLowerCase() : "";
  const text = typeof value.text === "string" ? value.text.trim().slice(0, 1_500) : "";
  const receivedAtMs = Number(value.receivedAtMs);
  if (!eventId || (handle && !HANDLE.test(handle)) || !text || !Number.isFinite(receivedAtMs)) return null;
  const displayName = typeof value.displayName === "string" ? value.displayName.trim().slice(0, 80) : "";
  const chatUserId = typeof value.chatUserId === "string" ? value.chatUserId.trim().slice(0, 80) : "";
  const twitterId = typeof value.twitterId === "string" ? value.twitterId.trim().slice(0, 80) : "";
  return { eventId, handle, displayName, chatUserId, twitterId, text, receivedAtMs };
}

export function shouldForwardXSpaceCaption(caption, selfHandle = "mira_theagent") {
  const captionHandle = String(caption?.handle || "").replace(/^@/, "").toLowerCase();
  const normalizedSelfHandle = String(selfHandle || "").replace(/^@/, "").toLowerCase();
  return !captionHandle || !normalizedSelfHandle || captionHandle !== normalizedSelfHandle;
}

export function buildXSpaceContext(caption) {
  return `[XCAP] speaker=@${caption.handle} name_json=${JSON.stringify(caption.displayName || "")} text_json=${JSON.stringify(caption.text)}`;
}

function safeError(value) {
  return String(value || "Listener X indisponível")
    .replace(/(auth_token|ct0)\s*[=:]\s*[^\s,;]+/gi, "$1=[oculto]")
    .slice(0, 180);
}

export class XSpaceSource extends EventEmitter {
  #config;
  #child;
  #status;
  #journalDir;

  constructor({ config, dataDir }) {
    super();
    this.#config = config;
    this.#journalDir = resolve(dataDir);
    this.#status = config.enabled
      ? { enabled: true, state: "connecting", roomId: config.roomId, captionCount: 0 }
      : { enabled: false, state: "disabled", captionCount: 0 };
  }

  get status() { return { ...this.#status }; }

  start() {
    if (!this.#config.enabled || this.#child) return;
    this.#setStatus({ enabled: true, state: "connecting", roomId: this.#config.roomId, captionCount: 0 });
    const child = spawn(this.#config.python, [
      join(this.#config.projectRoot, "xspace", "xspace_listener.py"),
      "--room-id", this.#config.roomId,
      "--cookies-file", this.#config.cookiesFile,
    ], { cwd: this.#config.projectRoot, stdio: ["ignore", "pipe", "pipe"] });
    this.#child = child;
    readline.createInterface({ input: child.stdout }).on("line", (line) => this.#handleLine(line));
    readline.createInterface({ input: child.stderr }).on("line", (line) => {
      this.#setStatus({ ...this.#status, state: "error", lastError: safeError(line) });
    });
    child.on("error", (error) => this.#setStatus({ ...this.#status, state: "error", lastError: safeError(error.message) }));
    child.on("exit", () => { if (this.#child === child) this.#child = undefined; });
  }

  configure(value) {
    const roomId = normalizeXSpaceRoomId(value);
    this.stop();
    this.#config = { ...this.#config, enabled: Boolean(roomId), roomId };
    if (!roomId) {
      this.#setStatus({ enabled: false, state: "disabled", captionCount: 0 });
      return this.status;
    }
    this.#setStatus({ enabled: true, state: "connecting", roomId, captionCount: 0 });
    this.start();
    return this.status;
  }

  stop() {
    this.#child?.kill("SIGTERM");
    this.#child = undefined;
  }

  #handleLine(line) {
    try {
      const value = JSON.parse(line);
      if (value.type === "status" && ["connecting", "connected", "error"].includes(value.state)) {
        this.#setStatus({
          ...this.#status,
          enabled: true,
          state: value.state,
          roomId: this.#config.roomId,
          lastError: value.state === "error" ? safeError(value.message) : undefined,
        });
        return;
      }
      if (value.type === "space_metadata" && value.roomId === this.#config.roomId) {
        const ownerHandle = typeof value.owner?.handle === "string"
          ? value.owner.handle.replace(/^@/, "").toLowerCase()
          : "";
        this.#setStatus({
          ...this.#status,
          ownerHandle: HANDLE.test(this.#config.ownerHandle) ? this.#config.ownerHandle
            : HANDLE.test(ownerHandle) ? ownerHandle : undefined,
          ownerDisplayName: typeof value.owner?.displayName === "string"
            ? value.owner.displayName.trim().slice(0, 80) : undefined,
          ownerTwitterId: typeof value.owner?.twitterId === "string"
            ? value.owner.twitterId.trim().slice(0, 80) : undefined,
          ownerIdentitySource: HANDLE.test(this.#config.ownerHandle) ? "env_override" : "x_space_metadata",
        });
        return;
      }
      if (value.type !== "caption") return;
      const caption = parseXSpaceCaption(value);
      if (!caption) return;
      this.#journal(caption);
      this.#status = {
        ...this.#status,
        captionCount: (this.#status.captionCount || 0) + 1,
        lastCaptionAtMs: caption.receivedAtMs,
      };
      this.emit("status", this.status);
      if (shouldForwardXSpaceCaption(caption, this.#config.selfHandle)) {
        this.emit("caption", { ...caption, final: true, spaceId: this.#config.roomId });
      }
    } catch {
      // Uma linha JSONL inválida nunca deve afetar a sessão de voz.
    }
  }

  #journal(caption) {
    mkdirSync(this.#journalDir, { recursive: true, mode: 0o700 });
    const path = join(this.#journalDir, `xspace-${this.#config.roomId}.jsonl`);
    appendFileSync(path, `${JSON.stringify({
      type: "x_space_caption",
      ...caption,
      provenance: "x_live_chat_final_caption",
    })}\n`, { encoding: "utf8", mode: 0o600 });
    chmodSync(path, 0o600);
  }

  #setStatus(status) {
    this.#status = status;
    this.emit("status", this.status);
  }
}
