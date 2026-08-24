import { createHash } from "node:crypto";

import { ZepClient } from "@getzep/zep-cloud";

const HANDLE = /^[A-Za-z0-9_]{1,15}$/;
const ALLOWED_BROWSER_SOURCES = new Set(["voice", "typed"]);
const DEFAULT_CONTEXT_TIMEOUT_MS = 350;
const DEFAULT_CONTEXT_MAX_CHARS = 12_000;

function boundedInteger(value, fallback, minimum, maximum) {
  const number = Number(value);
  return Number.isFinite(number)
    ? Math.max(minimum, Math.min(maximum, Math.round(number)))
    : fallback;
}

function enabledFlag(value) {
  return !["0", "false", "no", "off"].includes(String(value ?? "true").trim().toLowerCase());
}

function clean(value, maximum = 500) {
  return typeof value === "string" ? value.trim().slice(0, maximum) : "";
}

function isoTimestamp(value, fallback = Date.now()) {
  const date = new Date(value ?? fallback);
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date(fallback).toISOString();
}

function deterministicUuid(value) {
  const hex = createHash("sha256").update(String(value)).digest("hex").slice(0, 32).split("");
  hex[12] = "5";
  hex[16] = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8).join("")}-${hex.slice(8, 12).join("")}-${hex.slice(12, 16).join("")}-${hex.slice(16, 20).join("")}-${hex.slice(20).join("")}`;
}

function fallbackTurnId(turn) {
  return `turn_${createHash("sha256").update(JSON.stringify([
    turn.source,
    turn.spaceId,
    turn.speakerKind,
    turn.speakerHandle,
    turn.speakerId,
    turn.text,
    turn.timestamp,
  ])).digest("hex").slice(0, 32)}`;
}

function canonicalText(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLocaleLowerCase("und")
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeHandle(value) {
  const handle = clean(value, 40).replace(/^@/, "").toLowerCase();
  return HANDLE.test(handle) ? handle : "";
}

function metadataFor(turn) {
  return Object.fromEntries(Object.entries({
    source: turn.source,
    spaceId: turn.spaceId,
    speakerId: turn.speakerId,
    speakerIds: turn.speakerIds?.length ? turn.speakerIds : undefined,
    speakerHandle: turn.speakerHandle ? `@${turn.speakerHandle}` : undefined,
    speakerDisplayName: turn.speakerDisplayName,
    speakerKind: turn.speakerKind,
    aliases: turn.aliases?.length ? turn.aliases : undefined,
    timestamp: turn.timestamp,
    turnId: turn.turnId,
  }).filter(([, value]) => value !== undefined && value !== ""));
}

function messageIdentity(turn) {
  if (turn.speakerKind === "mira") return { role: "assistant", name: "Mira" };
  if (turn.speakerKind === "owner") return { role: "user", name: "Owner" };
  if (turn.speakerHandle) return { role: "norole", name: `@${turn.speakerHandle}` };
  if (turn.speakerId) return { role: "norole", name: `x-id:${turn.speakerId}` };
  return { role: "norole", name: "unknown" };
}

export function resolveZepConfig(env = process.env) {
  const requested = enabledFlag(env.ZEP_ENABLED);
  const apiKey = clean(env.ZEP_API_KEY, 2_000);
  const userId = clean(env.ZEP_USER_ID, 180);
  const enabled = requested && Boolean(apiKey) && Boolean(userId);
  const disabledReason = !requested
    ? "ZEP_ENABLED=false"
    : !apiKey ? "ZEP_API_KEY ausente" : !userId ? "ZEP_USER_ID ausente" : "";
  return {
    requested,
    enabled,
    disabledReason,
    apiKey,
    userId,
    ownerHandle: normalizeHandle(env.X_OWNER_HANDLE),
    ownerCaptionWaitMs: boundedInteger(env.ZEP_OWNER_CAPTION_WAIT_MS, 1_200, 250, 5_000),
    contextTimeoutMs: boundedInteger(
      env.ZEP_CONTEXT_TIMEOUT_MS,
      DEFAULT_CONTEXT_TIMEOUT_MS,
      50,
      5_000,
    ),
    contextMaxChars: boundedInteger(
      env.ZEP_CONTEXT_MAX_CHARS,
      DEFAULT_CONTEXT_MAX_CHARS,
      500,
      50_000,
    ),
  };
}

export function zepThreadIdForSpace(spaceId) {
  const source = clean(spaceId, 500);
  if (!source) throw new Error("Um Space/session ID é obrigatório para a thread Zep.");
  const readable = source.replace(/[^A-Za-z0-9_-]/g, "-").replace(/-+/g, "-").slice(0, 48) || "session";
  const digest = createHash("sha256").update(source).digest("hex").slice(0, 16);
  return `mira-${readable}-${digest}`;
}

export function normalizeXSpaceTurn(caption, {
  spaceId,
  ownerHandle = "",
  ownerTwitterId = "",
} = {}) {
  if (!caption || typeof caption !== "object") return null;
  const text = clean(caption.text, 10_000);
  const resolvedSpaceId = clean(spaceId || caption.spaceId, 180);
  if (!text || !resolvedSpaceId || caption.final === false) return null;
  const speakerHandle = normalizeHandle(caption.handle);
  const twitterId = clean(caption.twitterId, 180);
  const chatUserId = clean(caption.chatUserId, 180);
  const speakerIds = [...new Set([twitterId, chatUserId].filter(Boolean))];
  const speakerId = twitterId || chatUserId;
  const speakerDisplayName = clean(caption.displayName, 180);
  const normalizedOwner = normalizeHandle(ownerHandle);
  const normalizedOwnerTwitterId = clean(ownerTwitterId, 180);
  const isOwner = (speakerHandle && normalizedOwner && speakerHandle === normalizedOwner)
    || (twitterId && normalizedOwnerTwitterId && twitterId === normalizedOwnerTwitterId);
  const speakerKind = isOwner
    ? "owner"
    : speakerHandle || speakerId ? "external" : "unknown";
  return {
    final: true,
    turnId: clean(caption.turnId || caption.eventId, 180),
    source: "x_spaces",
    spaceId: resolvedSpaceId,
    speakerId,
    speakerIds,
    speakerHandle,
    speakerDisplayName,
    speakerKind,
    aliases: speakerDisplayName ? [speakerDisplayName] : [],
    text,
    timestamp: isoTimestamp(caption.receivedAtMs),
  };
}

export function normalizeBrowserTurn(value) {
  if (!value || typeof value !== "object" || value.final !== true) return null;
  const role = value.role === "assistant" ? "assistant" : value.role === "user" ? "user" : "";
  const source = clean(value.source, 40);
  const text = clean(value.text, 10_000);
  const spaceId = clean(value.spaceId, 180);
  if (!role || !ALLOWED_BROWSER_SOURCES.has(source) || !text || !spaceId) return null;
  return {
    final: true,
    turnId: clean(value.turnId || value.eventId, 180),
    source,
    spaceId,
    speakerId: "",
    speakerIds: [],
    speakerHandle: "",
    speakerDisplayName: role === "assistant" ? "Mira" : "Owner",
    speakerKind: role === "assistant" ? "mira" : "owner",
    aliases: [],
    text,
    timestamp: isoTimestamp(value.timestamp),
  };
}

export function zepMessageForTurn(turn) {
  if (!turn?.final || !turn.text) throw new Error("Apenas turns finalizados podem ser enviados ao Zep.");
  const turnId = clean(turn.turnId, 180) || fallbackTurnId(turn);
  const identity = messageIdentity(turn);
  return {
    content: turn.text,
    createdAt: turn.timestamp,
    metadata: metadataFor({ ...turn, turnId }),
    name: identity.name,
    role: identity.role,
    uuid: deterministicUuid(`${turn.spaceId}:${turnId}`),
  };
}

function errorStatus(error) {
  return Number(error?.statusCode || error?.status || error?.body?.status || error?.response?.status || 0);
}

function alreadyExists(error) {
  const status = errorStatus(error);
  const message = clean(error instanceof Error ? error.message : error, 500).toLowerCase();
  return status === 409 || (status === 400 && /already exists|duplicate/.test(message));
}

function safeError(error, secrets = []) {
  let value = clean(error instanceof Error ? error.message : error, 240)
    .replace(/z_[A-Za-z0-9._-]{20,}/g, "[secret omitted]");
  for (const secret of secrets.filter(Boolean)) value = value.replaceAll(secret, "[secret omitted]");
  return value;
}

export class ZepMemoryService {
  #client;
  #config;
  #logger;
  #userPromise;
  #threadPromises = new Map();
  #threadQueues = new Map();
  #turnPromises = new Map();
  #retrievalPromises = new Map();
  #recentFingerprints = new Map();

  constructor({ config = resolveZepConfig(), client, logger = console } = {}) {
    this.#config = config;
    this.#client = client || (config.enabled ? new ZepClient({ apiKey: config.apiKey }) : undefined);
    this.#logger = logger;
    if (config.enabled) this.#info("enabled", { userId: config.userId });
    else this.#info("disabled", { reason: config.disabledReason });
  }

  get status() {
    return {
      enabled: this.#config.enabled,
      configured: this.#config.requested,
      ...(this.#config.disabledReason ? { reason: this.#config.disabledReason } : {}),
      contextTimeoutMs: this.#config.contextTimeoutMs,
      contextMaxChars: this.#config.contextMaxChars,
      ownerCaptionWaitMs: this.#config.ownerCaptionWaitMs,
    };
  }

  start() {
    if (!this.#config.enabled) return Promise.resolve(false);
    return this.#ensureUser().then(() => true).catch((error) => {
      this.#warn("user_init_failed", { error: safeError(error, [this.#config.apiKey]) });
      return false;
    });
  }

  async ingest(turn, { returnContext = false } = {}) {
    if (!this.#config.enabled) return { ingested: false, context: "", disabled: true };
    const normalizedTurn = { ...turn, turnId: clean(turn.turnId, 180) || fallbackTurnId(turn) };
    const threadId = zepThreadIdForSpace(normalizedTurn.spaceId);
    const correlationId = `${threadId}:${normalizedTurn.turnId}`;
    if (this.#turnPromises.has(correlationId)) {
      this.#info("turn_deduplicated", { threadId, turnId: normalizedTurn.turnId, reason: "turn_id" });
      return this.#turnPromises.get(correlationId);
    }
    const fingerprint = this.#fingerprint(normalizedTurn);
    const duplicate = this.#recentFingerprints.get(fingerprint);
    if (duplicate && Date.now() - duplicate.at <= 60_000) {
      this.#info("turn_deduplicated", {
        threadId,
        turnId: normalizedTurn.turnId,
        originalTurnId: duplicate.turnId,
        reason: "finalized_turn_fingerprint",
      });
      const result = Promise.resolve({
        ingested: false,
        deduplicated: true,
        context: "",
        threadId,
        turnId: normalizedTurn.turnId,
      });
      this.#remember(this.#turnPromises, correlationId, result);
      return result;
    }
    this.#remember(this.#recentFingerprints, fingerprint, {
      turnId: normalizedTurn.turnId,
      at: Date.now(),
    });
    const promise = this.#enqueue(threadId, () => this.#ingestOnce(normalizedTurn, {
      returnContext,
      threadId,
    }));
    this.#remember(this.#turnPromises, correlationId, promise);
    return promise;
  }

  async retrieveContext({ spaceId, turnId }) {
    if (!this.#config.enabled) return { context: "", disabled: true, ingested: false };
    const threadId = zepThreadIdForSpace(spaceId);
    const normalizedTurnId = clean(turnId, 180);
    if (!normalizedTurnId) throw new Error("turnId é obrigatório para correlacionar retrieval Zep.");
    const correlationId = `${threadId}:${normalizedTurnId}`;
    if (this.#retrievalPromises.has(correlationId)) return this.#retrievalPromises.get(correlationId);
    const promise = this.#enqueue(threadId, () => this.#retrieveOnce({
      threadId,
      turnId: normalizedTurnId,
      spaceId,
    }));
    this.#remember(this.#retrievalPromises, correlationId, promise);
    return promise;
  }

  async #ingestOnce(turn, { returnContext, threadId }) {
    const startedAt = Date.now();
    const message = zepMessageForTurn(turn);
    this.#info("final_turn", {
      source: turn.source,
      spaceId: turn.spaceId,
      speakerKind: turn.speakerKind,
      handle: turn.speakerHandle ? `@${turn.speakerHandle}` : "",
      chars: turn.text.length,
    });
    try {
      await this.#ensureThread(threadId, turn.spaceId);
      const timeoutMs = returnContext ? this.#config.contextTimeoutMs : Math.max(2_000, this.#config.contextTimeoutMs);
      const response = await this.#client.thread.addMessages(threadId, {
        messages: [message],
        returnContext,
      }, {
        abortSignal: AbortSignal.timeout(timeoutMs),
        maxRetries: 0,
      });
      const rawContext = returnContext ? clean(response?.context, 100_000) : "";
      const context = rawContext.slice(0, this.#config.contextMaxChars);
      const latencyMs = Date.now() - startedAt;
      this.#info("ingest_ok", {
        threadId,
        speakerKind: turn.speakerKind,
        latencyMs,
        context: Boolean(context),
        contextChars: context.length,
        contextTruncated: rawContext.length > context.length,
      });
      return { ingested: true, context, threadId, latencyMs };
    } catch (error) {
      const latencyMs = Date.now() - startedAt;
      const timedOut = error?.name === "AbortError" || error?.name === "TimeoutError";
      this.#warn(timedOut ? "timeout_fallback" : "ingest_failed", {
        threadId,
        speakerKind: turn.speakerKind,
        latencyMs,
        error: safeError(error, [this.#config.apiKey]),
      });
      return {
        ingested: false,
        context: "",
        threadId,
        latencyMs,
        timedOut,
        error: safeError(error, [this.#config.apiKey]),
      };
    }
  }

  async #retrieveOnce({ threadId, turnId, spaceId }) {
    const startedAt = Date.now();
    try {
      await this.#ensureThread(threadId, spaceId);
      const response = await this.#client.thread.getUserContext(threadId, {}, {
        abortSignal: AbortSignal.timeout(this.#config.contextTimeoutMs),
        maxRetries: 0,
      });
      const rawContext = clean(response?.context, 100_000);
      const context = rawContext.slice(0, this.#config.contextMaxChars);
      const latencyMs = Date.now() - startedAt;
      this.#info("context_ok", {
        threadId,
        turnId,
        latencyMs,
        context: Boolean(context),
        contextChars: context.length,
        contextTruncated: rawContext.length > context.length,
      });
      return { ingested: false, context, threadId, turnId, latencyMs };
    } catch (error) {
      const latencyMs = Date.now() - startedAt;
      const timedOut = error?.name === "AbortError" || error?.name === "TimeoutError";
      this.#warn(timedOut ? "context_timeout_fallback" : "context_failed", {
        threadId,
        turnId,
        latencyMs,
        error: safeError(error, [this.#config.apiKey]),
      });
      return {
        ingested: false,
        context: "",
        threadId,
        turnId,
        latencyMs,
        timedOut,
        error: safeError(error, [this.#config.apiKey]),
      };
    }
  }

  #enqueue(threadId, operation) {
    const previous = this.#threadQueues.get(threadId) || Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    const tail = current.finally(() => {
      if (this.#threadQueues.get(threadId) === tail) this.#threadQueues.delete(threadId);
    });
    this.#threadQueues.set(threadId, tail);
    return current;
  }

  #fingerprint(turn) {
    const stableSpeaker = turn.speakerKind === "owner"
      ? ["owner"]
      : [turn.speakerKind, turn.speakerHandle, turn.speakerId];
    return createHash("sha256").update(JSON.stringify([
      turn.spaceId,
      ...stableSpeaker,
      canonicalText(turn.text),
    ])).digest("hex");
  }

  #remember(map, key, value, maximum = 2_048) {
    map.set(key, value);
    while (map.size > maximum) map.delete(map.keys().next().value);
  }

  async #ensureUser() {
    if (this.#userPromise) return this.#userPromise;
    this.#userPromise = (async () => {
      try {
        await this.#client.user.get(this.#config.userId, { maxRetries: 0 });
        this.#info("user_ready", { userId: this.#config.userId, created: false });
      } catch (error) {
        if (errorStatus(error) !== 404) throw error;
        try {
          await this.#client.user.add({
            userId: this.#config.userId,
            firstName: "Mira",
            metadata: { application: "mira", source: "x_spaces" },
          }, { maxRetries: 0 });
          this.#info("user_ready", { userId: this.#config.userId, created: true });
        } catch (createError) {
          if (!alreadyExists(createError)) throw createError;
          this.#info("user_ready", { userId: this.#config.userId, created: false });
        }
      }
    })();
    try {
      return await this.#userPromise;
    } catch (error) {
      this.#userPromise = undefined;
      throw error;
    }
  }

  async #ensureThread(threadId, spaceId) {
    if (!this.#threadPromises.has(threadId)) {
      this.#threadPromises.set(threadId, (async () => {
        await this.#ensureUser();
        try {
          await this.#client.thread.create({ threadId, userId: this.#config.userId }, { maxRetries: 0 });
          this.#info("thread_ready", { threadId, spaceId, created: true });
        } catch (error) {
          if (!alreadyExists(error)) throw error;
          this.#info("thread_ready", { threadId, spaceId, created: false });
        }
        this.#info("space_thread_mapping", { spaceId, threadId });
      })());
    }
    try {
      return await this.#threadPromises.get(threadId);
    } catch (error) {
      this.#threadPromises.delete(threadId);
      throw error;
    }
  }

  #info(event, fields) {
    this.#logger.info?.(`[Zep] ${event} ${JSON.stringify(fields)}`);
  }

  #warn(event, fields) {
    this.#logger.warn?.(`[Zep] ${event} ${JSON.stringify(fields)}`);
  }
}

export function zepTurnTextMatches(left, right) {
  const a = canonicalText(left);
  const b = canonicalText(right);
  if (!a || !b) return false;
  if (a === b) return true;
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  if (shorter.length >= 8 && longer.includes(shorter)) return true;
  const aTokens = new Set(a.split(" ").filter((token) => token.length > 1));
  const bTokens = new Set(b.split(" ").filter((token) => token.length > 1));
  const shared = [...aTokens].filter((token) => bTokens.has(token)).length;
  const minimum = Math.min(aTokens.size, bTokens.size);
  return shared >= 2 && minimum > 0 && shared / minimum >= 0.75;
}

export class ZepTurnCoordinator {
  #zep;
  #waitMs;
  #now;
  #setTimer;
  #clearTimer;
  #logger;
  #pending = new Map();
  #recentCaptions = new Map();

  constructor({
    zep,
    ownerCaptionWaitMs = 1_200,
    now = () => Date.now(),
    setTimer = (callback, delay) => setTimeout(callback, delay),
    clearTimer = (timer) => clearTimeout(timer),
    logger = console,
  }) {
    this.#zep = zep;
    this.#waitMs = ownerCaptionWaitMs;
    this.#now = now;
    this.#setTimer = setTimer;
    this.#clearTimer = clearTimer;
    this.#logger = logger;
  }

  ingestX(turn) {
    this.#prune(turn.spaceId);
    if (turn.speakerKind !== "owner") return this.#zep.ingest(turn, { returnContext: false });
    const caption = { turnId: turn.turnId, text: turn.text, at: this.#now() };
    const recent = this.#recentCaptions.get(turn.spaceId) || [];
    recent.push(caption);
    this.#recentCaptions.set(turn.spaceId, recent.slice(-64));
    const pending = this.#pending.get(turn.spaceId) || [];
    const match = pending.find((entry) => zepTurnTextMatches(entry.turn.text, turn.text));
    if (match) {
      if (match.timer) this.#clearTimer(match.timer);
      match.captionMatched = true;
      this.#info("owner_caption_preferred", {
        spaceId: turn.spaceId,
        realtimeTurnId: match.turn.turnId,
        captionTurnId: turn.turnId,
        fallbackStarted: match.fallbackStarted,
      });
      return this.#zep.ingest({ ...turn, turnId: match.turn.turnId }, { returnContext: false });
    }
    return this.#zep.ingest(turn, { returnContext: false });
  }

  async ingestBrowser(turn, { returnContext = false, xspace = {} } = {}) {
    const activeX = Boolean(xspace.roomId)
      && xspace.roomId === turn.spaceId
      && ["connecting", "connected"].includes(String(xspace.state || ""));
    if (turn.speakerKind !== "owner" || turn.source !== "voice" || !activeX) {
      return this.#zep.ingest(turn, { returnContext });
    }
    this.#prune(turn.spaceId);
    const recent = this.#recentCaptions.get(turn.spaceId) || [];
    if (recent.some((caption) => zepTurnTextMatches(turn.text, caption.text))) {
      this.#info("owner_realtime_deduplicated", {
        spaceId: turn.spaceId,
        turnId: turn.turnId,
        reason: "matching_x_caption_already_received",
      });
      return this.#zep.retrieveContext({ spaceId: turn.spaceId, turnId: turn.turnId });
    }
    const entry = {
      turn,
      createdAt: this.#now(),
      expiresAt: this.#now() + 60_000,
      captionMatched: false,
      fallbackStarted: false,
      timer: undefined,
    };
    const pending = this.#pending.get(turn.spaceId) || [];
    pending.push(entry);
    this.#pending.set(turn.spaceId, pending.slice(-64));
    entry.timer = this.#setTimer(() => {
      if (entry.captionMatched) return;
      entry.fallbackStarted = true;
      this.#info("owner_realtime_fallback", {
        spaceId: turn.spaceId,
        turnId: turn.turnId,
        waitMs: this.#waitMs,
      });
      void this.#zep.ingest(turn, { returnContext: false });
    }, this.#waitMs);
    const context = await this.#zep.retrieveContext({ spaceId: turn.spaceId, turnId: turn.turnId });
    return { ...context, pendingIngest: true, captionWaitMs: this.#waitMs };
  }

  #prune(spaceId) {
    const now = this.#now();
    this.#recentCaptions.set(
      spaceId,
      (this.#recentCaptions.get(spaceId) || []).filter((entry) => now - entry.at <= 30_000),
    );
    this.#pending.set(
      spaceId,
      (this.#pending.get(spaceId) || []).filter((entry) => entry.expiresAt > now),
    );
  }

  #info(event, fields) {
    this.#logger.info?.(`[Zep] ${event} ${JSON.stringify(fields)}`);
  }
}
