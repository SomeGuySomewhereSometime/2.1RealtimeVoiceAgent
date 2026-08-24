import test from "node:test";
import assert from "node:assert/strict";

import {
  ZepMemoryService,
  ZepTurnCoordinator,
  normalizeBrowserTurn,
  normalizeXSpaceTurn,
  resolveZepConfig,
  zepMessageForTurn,
  zepThreadIdForSpace,
  zepTurnTextMatches,
} from "../zep-memory.mjs";

function config(overrides = {}) {
  return {
    requested: true,
    enabled: true,
    disabledReason: "",
    apiKey: "secret-never-log",
    userId: "owner-main",
    ownerName: "Owner",
    ownerHandle: "owner_x",
    contextTimeoutMs: 100,
    contextMaxChars: 12_000,
    ingestTimeoutMs: 1_000,
    ownerCaptionWaitMs: 1_200,
    ...overrides,
  };
}

function fakeClient({
  context = "historical context",
  addMessages,
  getUserContext,
  getUser,
  addUser,
  updateUser,
  createThread,
  getThread,
} = {}) {
  const calls = { users: [], threads: [], messages: [], threadGets: [], contexts: [] };
  return {
    calls,
    user: {
      async get(userId) {
        calls.users.push(["get", userId]);
        return getUser ? getUser(userId) : { userId, firstName: "Owner" };
      },
      async add(value) {
        calls.users.push(["add", value]);
        return addUser ? addUser(value) : value;
      },
      async update(userId, value) {
        calls.users.push(["update", userId, value]);
        return updateUser ? updateUser(userId, value) : { userId, ...value };
      },
    },
    thread: {
      async create(value, options) {
        calls.threads.push(value);
        return createThread ? createThread(value, options, calls) : value;
      },
      async get(threadId, request, options) {
        calls.threadGets.push({ threadId, request, options });
        return getThread ? getThread(threadId, request, options, calls) : { messages: [], totalCount: 0 };
      },
      async addMessages(threadId, request, options) {
        calls.messages.push({ threadId, request, options });
        return addMessages ? addMessages(threadId, request, options, calls) : { context };
      },
      async getUserContext(threadId, request, options) {
        calls.contexts.push({ threadId, request, options });
        return getUserContext ? getUserContext(threadId, request, options, calls) : { context };
      },
    },
  };
}

function external(overrides = {}) {
  return normalizeXSpaceTurn({
    final: true,
    eventId: "xcap-1",
    handle: "@Alice42",
    displayName: "Alice",
    twitterId: "twitter-1",
    chatUserId: "chat-1",
    text: "UBI will become necessary because automation will remove many jobs.",
    receivedAtMs: Date.parse("2026-01-01T10:00:00Z"),
    ...overrides,
  }, { spaceId: "space-1", ownerHandle: "owner_x" });
}

test("a configuração é fail-open e nunca precisa de uma chave hardcoded", () => {
  assert.equal(resolveZepConfig({ ZEP_ENABLED: "true", ZEP_USER_ID: "owner-main" }).enabled, false);
  assert.equal(resolveZepConfig({ ZEP_ENABLED: "false", ZEP_API_KEY: "x", ZEP_USER_ID: "owner-main" }).enabled, false);
  const enabled = resolveZepConfig({
    ZEP_ENABLED: "true",
    ZEP_API_KEY: "from-environment",
    ZEP_USER_ID: "owner-main",
    ZEP_CONTEXT_TIMEOUT_MS: "250",
  });
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.contextTimeoutMs, 250);
  assert.equal(resolveZepConfig({}).contextTimeoutMs, 500);
  assert.equal(enabled.ownerName, "Owner");
  assert.equal(resolveZepConfig({ ZEP_OWNER_NAME: "Mira" }).ownerName, "Owner");
});

test("Zep User é criado como owner e nunca recebe o nome Mira", async () => {
  const notFound = Object.assign(new Error("not found"), { statusCode: 404 });
  const client = fakeClient({ getUser: async () => { throw notFound; } });
  const service = new ZepMemoryService({
    config: config({ ownerName: "Human Owner" }),
    client,
    logger: { info() {}, warn() {} },
  });
  assert.equal(await service.start(), true);
  const created = client.calls.users.find(([kind]) => kind === "add")[1];
  assert.equal(created.userId, "owner-main");
  assert.equal(created.firstName, "Human Owner");
  assert.notEqual(created.firstName, "Mira");
});

test("um User legado chamado Mira é reparado para o nome seguro do owner", async () => {
  const client = fakeClient({ getUser: async (userId) => ({ userId, firstName: "Mira" }) });
  const service = new ZepMemoryService({ config: config(), client, logger: { info() {}, warn() {} } });
  assert.equal(await service.start(), true);
  assert.deepEqual(client.calls.users.find(([kind]) => kind === "update"), [
    "update",
    "owner-main",
    { firstName: "Owner" },
  ]);
});

test("só normaliza turns finais e mantém transcript e identidade em campos separados", () => {
  assert.equal(normalizeBrowserTurn({ final: false, role: "user", text: "partial", source: "voice", spaceId: "s" }), null);
  assert.equal(normalizeBrowserTurn({ final: true, role: "system", text: "memory", source: "voice", spaceId: "s" }), null);
  const turn = external();
  assert.equal(turn.text, "UBI will become necessary because automation will remove many jobs.");
  assert.equal(turn.speakerHandle, "alice42");
  assert.equal(turn.speakerId, "twitter-1");
  assert.deepEqual(turn.speakerIds, ["twitter-1", "chat-1"]);
  assert.equal(turn.speakerKind, "external");
  const message = zepMessageForTurn(turn);
  assert.equal(message.content, turn.text);
  assert.equal(message.role, "norole");
  assert.equal(message.name, "@alice42");
  assert.equal(message.metadata.speakerDisplayName, "Alice");
  assert.doesNotMatch(message.content, /speakerHandle|displayName|metadata/);
  assert.match(message.uuid, /^[0-9a-f-]{36}$/);
});

test("handle estável prevalece sobre display name e speakers distintos não são fundidos", () => {
  const first = zepMessageForTurn(external({ displayName: "Alice" }));
  const renamed = zepMessageForTurn(external({ eventId: "xcap-2", displayName: "Alice 🇵🇹" }));
  const bob = zepMessageForTurn(external({ eventId: "xcap-3", handle: "bob", displayName: "Alice" }));
  assert.equal(first.name, "@alice42");
  assert.equal(renamed.name, first.name);
  assert.equal(bob.name, "@bob");
  assert.notEqual(bob.name, first.name);
});

test("identidade em falta fica unknown e nunca usa display name como identidade", () => {
  const turn = external({ handle: "", twitterId: "", chatUserId: "", displayName: "Alice" });
  assert.equal(turn.speakerKind, "unknown");
  const message = zepMessageForTurn(turn);
  assert.equal(message.role, "norole");
  assert.equal(message.name, "unknown");
  assert.equal(message.metadata.speakerDisplayName, "Alice");
});

test("owner é User, Mira é Assistant e externos continuam norole", () => {
  const owner = normalizeXSpaceTurn({
    eventId: "owner-turn",
    handle: "owner_x",
    text: "My view.",
    receivedAtMs: 1,
  }, { spaceId: "space", ownerHandle: "owner_x" });
  const mira = normalizeBrowserTurn({
    final: true,
    role: "assistant",
    source: "voice",
    spaceId: "space",
    turnId: "mira-turn",
    text: "My response.",
  });
  assert.deepEqual(
    [zepMessageForTurn(owner).role, zepMessageForTurn(mira).role, zepMessageForTurn(external()).role],
    ["user", "assistant", "norole"],
  );
  assert.equal(zepMessageForTurn(mira).name, "Mira");
});

test("owner também é reconhecido pelo twitter ID estruturado quando o handle falta", () => {
  const owner = normalizeXSpaceTurn({
    eventId: "owner-by-id",
    handle: "",
    twitterId: "owner-twitter-id",
    text: "My view without a caption handle.",
    receivedAtMs: 1,
  }, {
    spaceId: "space",
    ownerTwitterId: "owner-twitter-id",
  });
  assert.equal(owner.speakerKind, "owner");
  assert.equal(zepMessageForTurn(owner).role, "user");
});

test("thread é determinística por Space e reconexão reutiliza a mesma criação", async () => {
  const client = fakeClient();
  const service = new ZepMemoryService({ config: config(), client, logger: { info() {}, warn() {} } });
  const first = external({ eventId: "one", text: "First statement" });
  const second = external({ eventId: "two", text: "Second statement" });
  await service.ingest(first);
  await service.ingest(second);
  assert.equal(client.calls.threads.length, 1);
  assert.equal(client.calls.messages[0].threadId, client.calls.messages[1].threadId);
  assert.equal(client.calls.messages[0].threadId, zepThreadIdForSpace("space-1"));
  assert.notEqual(zepThreadIdForSpace("space-1"), zepThreadIdForSpace("space-2"));
});

test("turn ID e fingerprint tornam finalized turns idempotentes em replay", async () => {
  const client = fakeClient();
  const service = new ZepMemoryService({ config: config(), client, logger: { info() {}, warn() {} } });
  const turn = external({ eventId: "stable-x-event" });
  const [first, sameId, replayId] = await Promise.all([
    service.ingest(turn),
    service.ingest({ ...turn }),
    service.ingest({ ...turn, turnId: "replayed-with-new-id" }),
  ]);
  assert.equal(first.ingested, true);
  assert.equal(sameId.ingested, true, "o mesmo turn ID recebe o mesmo resultado correlacionado");
  assert.equal(replayId.deduplicated, true);
  assert.equal(client.calls.messages.length, 1);
});

test("ingestão dedicada é ordenada por thread e nunca pede returnContext", async () => {
  let releaseFirst;
  const firstBlocked = new Promise((resolve) => { releaseFirst = resolve; });
  const client = fakeClient({
    async addMessages(_threadId, request) {
      if (request.messages[0].metadata.turnId === "turn-1") await firstBlocked;
      return {};
    },
  });
  const service = new ZepMemoryService({ config: config(), client, logger: { info() {}, warn() {} } });
  const one = service.ingest({ ...external({ eventId: "turn-1", text: "One" }), turnId: "turn-1" });
  const two = service.ingest({ ...external({ eventId: "turn-2", text: "Two" }), turnId: "turn-2" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(client.calls.messages.length, 1);
  releaseFirst();
  assert.equal((await one).ingested, true);
  assert.equal((await two).ingested, true);
  assert.equal(client.calls.messages.length, 2);
  assert.ok(client.calls.messages.every((call) => call.request.returnContext === false));
  assert.ok(client.calls.messages.every((call) => call.options.maxRetries === 0));
});

test("reconnect consulta turnId persistido e não cria outro episódio", async () => {
  const remoteMessages = [];
  let threadExists = false;
  const shared = {
    async createThread() {
      if (threadExists) throw Object.assign(new Error("already exists"), { statusCode: 409 });
      threadExists = true;
    },
    async getThread() {
      return { messages: remoteMessages, totalCount: remoteMessages.length };
    },
    async addMessages(_threadId, request) {
      remoteMessages.push(...request.messages);
      return {};
    },
  };
  const firstClient = fakeClient(shared);
  const firstService = new ZepMemoryService({ config: config(), client: firstClient, logger: { info() {}, warn() {} } });
  const turn = external({ eventId: "reconnect-turn" });
  assert.equal((await firstService.ingest(turn)).ingested, true);

  const reconnectClient = fakeClient(shared);
  const reconnectService = new ZepMemoryService({ config: config(), client: reconnectClient, logger: { info() {}, warn() {} } });
  const replay = await reconnectService.ingest(turn);
  assert.equal(replay.deduplicated, true);
  assert.equal(remoteMessages.length, 1);
  assert.equal(reconnectClient.calls.messages.length, 0);
});

test("retry após resultado incerto confirma turnId antes de voltar a escrever", async () => {
  const remoteMessages = [];
  const client = fakeClient({
    async getThread() { return { messages: remoteMessages, totalCount: remoteMessages.length }; },
    async addMessages(_threadId, request) {
      remoteMessages.push(...request.messages);
      throw new Error("connection reset after write");
    },
  });
  const service = new ZepMemoryService({ config: config(), client, logger: { info() {}, warn() {} } });
  const result = await service.ingest(external({ eventId: "uncertain-write" }));
  assert.equal(result.deduplicated, true);
  assert.equal(client.calls.messages.length, 1);
  assert.equal(remoteMessages.length, 1);
});

test("timeout de retrieval devolve fail-open sem cancelar ingestão ainda pendente", async () => {
  let releaseIngest;
  let ingestionFinished = false;
  const blocked = new Promise((resolve) => { releaseIngest = resolve; });
  const client = fakeClient({
    async addMessages() {
      await blocked;
      ingestionFinished = true;
      return {};
    },
    async getUserContext(_threadId, _request, options) {
      await new Promise((resolve, reject) => {
        const keepAlive = setTimeout(resolve, 100);
        options.abortSignal.addEventListener("abort", () => {
          clearTimeout(keepAlive);
          const error = new Error("The user aborted a request");
          reject(error);
        }, { once: true });
      });
    },
  });
  const service = new ZepMemoryService({
    config: config({ contextTimeoutMs: 20, ingestTimeoutMs: 1_000 }),
    client,
    logger: { info() {}, warn() {} },
  });
  const ingestion = service.ingest(external({ eventId: "slow-ingest" }));
  const retrieval = await service.retrieveContext({ spaceId: "space-1", turnId: "slow-ingest" });
  assert.equal(retrieval.context, "");
  assert.equal(retrieval.timedOut, true);
  assert.equal(ingestionFinished, false, "response pode prosseguir antes de a escrita terminar");
  releaseIngest();
  assert.equal((await ingestion).ingested, true);
  assert.equal(ingestionFinished, true, "o turno acaba por ficar ingerido");
  assert.equal(client.calls.messages.length, 1);
});

test("o orçamento de retrieval inclui bootstrap lento da thread", async () => {
  let releaseThread;
  const blocked = new Promise((resolve) => { releaseThread = resolve; });
  const client = fakeClient({ createThread: async () => blocked });
  const service = new ZepMemoryService({
    config: config({ contextTimeoutMs: 20 }),
    client,
    logger: { info() {}, warn() {} },
  });
  const keepAlive = setTimeout(() => undefined, 100);
  const startedAt = Date.now();
  const result = await service.retrieveContext({ spaceId: "slow-bootstrap", turnId: "slow-bootstrap-turn" });
  clearTimeout(keepAlive);
  assert.equal(result.timedOut, true);
  assert.ok(Date.now() - startedAt < 90, "a criação da thread não pode escapar ao orçamento de retrieval");
  assert.equal(client.calls.contexts.length, 0, "não inicia getUserContext depois de o orçamento expirar");
  releaseThread();
  await new Promise((resolve) => setImmediate(resolve));
});

test("retrieval sem ingestão é deduplicado e correlacionado para owner via X", async () => {
  const client = fakeClient({ getUserContext: async () => ({ context: "previous debate" }) });
  const service = new ZepMemoryService({ config: config(), client, logger: { info() {}, warn() {} } });
  const first = service.retrieveContext({ spaceId: "space-1", turnId: "voice-item-1" });
  const replay = service.retrieveContext({ spaceId: "space-1", turnId: "voice-item-1" });
  assert.equal((await first).context, "previous debate");
  assert.equal((await replay).turnId, "voice-item-1");
  assert.equal(client.calls.contexts.length, 1);
  assert.equal(client.calls.messages.length, 0);
});

test("correlação textual reconhece captions normalizadas e fragmentos úteis", () => {
  assert.equal(zepTurnTextMatches(
    "I support UBI because automation will remove many jobs.",
    "support UBI because automation",
  ), true);
  assert.equal(zepTurnTextMatches("A completely different point", "hello"), false);
  assert.equal(zepTurnTextMatches("uh", "uh I think something else"), false);
});

test("caption X preferida evita ingestão Realtime duplicada quando chega primeiro", async () => {
  const calls = { ingest: [] };
  const zep = {
    async ingest(turn) { calls.ingest.push(turn); return { ingested: true }; },
  };
  const coordinator = new ZepTurnCoordinator({ zep, logger: { info() {} } });
  const ownerCaption = normalizeXSpaceTurn({
    eventId: "x-owner-1",
    handle: "owner_x",
    text: "I support UBI because automation will remove jobs",
    receivedAtMs: 1,
  }, { spaceId: "space-1", ownerHandle: "owner_x" });
  await coordinator.ingestX(ownerCaption);
  const realtime = normalizeBrowserTurn({
    final: true,
    role: "user",
    source: "voice",
    spaceId: "space-1",
    turnId: "rt-owner-1",
    text: "I support UBI because automation will remove many jobs.",
  });
  const result = await coordinator.ingestBrowser(realtime, {
    xspace: { roomId: "space-1", state: "connected" },
  });
  assert.equal(result.context, "");
  assert.equal(result.deduplicated, true);
  assert.equal(calls.ingest.length, 1, "só a caption X foi ingerida");
  assert.equal(calls.ingest[0].source, "x_spaces");
});

test("Realtime owner tem fallback se caption não chega e caption tardia reutiliza o turn ID", async () => {
  const calls = { ingest: [], retrieve: [] };
  const timers = [];
  const zep = {
    async ingest(turn) { calls.ingest.push(turn); return { ingested: true }; },
    async retrieveContext(value) { calls.retrieve.push(value); return { context: "prior", turnId: value.turnId }; },
  };
  const coordinator = new ZepTurnCoordinator({
    zep,
    ownerCaptionWaitMs: 500,
    setTimer(callback, delay) { const timer = { callback, delay, cleared: false }; timers.push(timer); return timer; },
    clearTimer(timer) { timer.cleared = true; },
    logger: { info() {} },
  });
  const realtime = normalizeBrowserTurn({
    final: true,
    role: "user",
    source: "voice",
    spaceId: "space-1",
    turnId: "rt-owner-late",
    text: "I changed my mind about UBI",
  });
  const result = await coordinator.ingestBrowser(realtime, {
    xspace: { roomId: "space-1", state: "connected" },
  });
  assert.equal(result.pendingIngest, true);
  assert.equal(calls.ingest.length, 0);
  await timers[0].callback();
  assert.equal(calls.ingest.length, 1);
  assert.equal(calls.ingest[0].turnId, "rt-owner-late");

  const lateCaption = normalizeXSpaceTurn({
    eventId: "late-x-id",
    handle: "owner_x",
    text: "changed my mind about UBI",
    receivedAtMs: 2,
  }, { spaceId: "space-1", ownerHandle: "owner_x" });
  await coordinator.ingestX(lateCaption);
  assert.equal(calls.ingest[1].turnId, "rt-owner-late", "a caption tardia herda a correlação Realtime");
});

test("falha do caption path ingere owner Realtime imediatamente", async () => {
  const calls = [];
  const zep = {
    async ingest(turn) { calls.push(turn); return { ingested: true, context: "fallback-context" }; },
    async retrieveContext() { throw new Error("não devia ser chamado"); },
  };
  const coordinator = new ZepTurnCoordinator({ zep, logger: { info() {} } });
  const realtime = normalizeBrowserTurn({
    final: true,
    role: "user",
    source: "voice",
    spaceId: "space-1",
    turnId: "rt-error-path",
    text: "Remember this even if X failed",
  });
  const result = await coordinator.ingestBrowser(realtime, {
    xspace: { roomId: "space-1", state: "error" },
  });
  assert.equal(result.ingested, true);
  assert.equal(calls.length, 1);
});

test("falha e timeout Zep devolvem fallback e nunca expõem a API key em logs", async () => {
  const logs = [];
  const client = fakeClient({ addMessages: async () => { throw new Error("network failed secret-never-log"); } });
  const service = new ZepMemoryService({
    config: config(),
    client,
    logger: { info: (line) => logs.push(line), warn: (line) => logs.push(line) },
  });
  const result = await service.ingest(external());
  assert.equal(result.ingested, false);
  assert.equal(result.context, "");
  assert.equal(logs.join("\n").includes("secret-never-log"), false);

  const retrievalClient = fakeClient({ getUserContext: async () => { throw new Error("context unavailable"); } });
  const retrievalService = new ZepMemoryService({
    config: config(),
    client: retrievalClient,
    logger: { info() {}, warn() {} },
  });
  const retrieval = await retrievalService.retrieveContext({ spaceId: "space-1", turnId: "failed-context" });
  assert.equal(retrieval.context, "");
  assert.equal(retrieval.ingested, false);
});

test("o context block respeita o limite sem alterar o formato antes de o receber", async () => {
  const client = fakeClient({ context: "abcdef" });
  const service = new ZepMemoryService({
    config: config({ contextMaxChars: 3 }),
    client,
    logger: { info() {}, warn() {} },
  });
  const result = await service.retrieveContext({ spaceId: "space-1", turnId: "context-limit" });
  assert.equal(result.context, "abc");
});

test("simulação de dois Spaces preserva Alice, separa Bob e guarda a resposta da Mira", async () => {
  const client = fakeClient({
    getUserContext: async () => ({
      context: "@alice42 previously supported UBI because of automation; Bob challenged that view; Mira questioned whether future automation is qualitatively different.",
    }),
  });
  const service = new ZepMemoryService({ config: config(), client, logger: { info() {}, warn() {} } });
  const aliceSpace1 = external({
    eventId: "alice-space-1",
    handle: "alice42",
    displayName: "Alice",
    text: "I support UBI because automation will eliminate many jobs.",
  });
  const bobSpace1 = external({
    eventId: "bob-space-1",
    handle: "bob",
    displayName: "Bob",
    twitterId: "twitter-bob",
    chatUserId: "",
    text: "I disagree. Automation historically creates new types of work.",
  });
  const miraSpace1 = normalizeBrowserTurn({
    final: true,
    role: "assistant",
    source: "voice",
    spaceId: "space-1",
    turnId: "mira-space-1",
    text: "The disagreement depends on whether future automation differs qualitatively from previous technological shifts.",
  });
  await service.ingest(aliceSpace1);
  await service.ingest(bobSpace1);
  await service.ingest(miraSpace1);

  const aliceSpace2 = normalizeXSpaceTurn({
    final: true,
    eventId: "alice-space-2",
    handle: "alice42",
    displayName: "Alice 🇵🇹",
    twitterId: "twitter-1",
    text: "I've changed my mind. I'm no longer convinced UBI is necessary.",
    receivedAtMs: Date.parse("2026-08-01T10:00:00Z"),
  }, { spaceId: "space-2", ownerHandle: "owner_x" });
  await service.ingest(aliceSpace2);
  const result = await service.retrieveContext({ spaceId: "space-2", turnId: aliceSpace2.turnId });

  const messages = client.calls.messages.map((call) => call.request.messages[0]);
  assert.deepEqual(messages.map((message) => message.name), ["@alice42", "@bob", "Mira", "@alice42"]);
  assert.deepEqual(messages.map((message) => message.role), ["norole", "norole", "assistant", "norole"]);
  assert.equal(messages[0].metadata.speakerId, messages[3].metadata.speakerId);
  assert.notEqual(messages[0].content, messages[3].content);
  assert.equal(new Set(client.calls.messages.map((call) => call.threadId)).size, 2);
  assert.match(result.context, /previously supported UBI/);
  assert.match(result.context, /Mira questioned/);
});
