import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CODEX_MODEL,
  CODEX_REASONING_EFFORT,
  CodexBrain,
  ConversationJournal,
  normalizeConsultKind,
} from "../codex-app-server.mjs";

function temporaryDirectory() {
  return mkdtempSync(join(tmpdir(), "codex-realtime-21-test-"));
}

class FakeCodexClient {
  running = true;
  requests = [];
  turns = [];
  closed = false;
  nextThread = 1;
  persistenceGate;

  async request(method, params) {
    this.requests.push({ method, params });
    if (method === "thread/start") return { thread: { id: `thread-${this.nextThread++}` } };
    if (method === "thread/resume") return { thread: { id: params.threadId } };
    if (method === "thread/fork") return { thread: { id: `research-${this.nextThread++}` } };
    if (method === "turn/interrupt") return {};
    throw new Error(`Método inesperado: ${method}`);
  }

  async runTurn(threadId, prompt, options) {
    this.turns.push({ threadId, prompt, options });
    if (threadId.startsWith("research-")) {
      return "Resultado pesquisado. Fonte: https://example.com/fonte";
    }
    if (prompt.includes("Responde apenas OK")) {
      if (this.persistenceGate) await this.persistenceGate;
      return "OK";
    }
    return "Orientação persistente do Codex.";
  }

  async interrupt() { return true; }
  async close() { this.closed = true; }
}

test("normaliza os modos permitidos da consulta", () => {
  assert.equal(CODEX_MODEL, "gpt-5.6-luna");
  assert.equal(CODEX_REASONING_EFFORT, "low");
  assert.equal(normalizeConsultKind("research"), "research");
  assert.equal(normalizeConsultKind("destruir"), "conversation");
});

test("o diário JSONL mantém sequência e proveniência", () => {
  const directory = temporaryDirectory();
  try {
    const journal = new ConversationJournal(directory);
    assert.equal(journal.append({ role: "user", text: "Olá", source: "voice" }).seq, 1);
    assert.equal(journal.append({
      role: "assistant",
      text: "Olá!",
      source: "voice",
      consultJobId: "call-1",
    }).seq, 2);
    journal.appendConsult({
      jobId: "call-1",
      kind: "reasoning",
      question: "Analisa isto",
      prompt: "MODO: reasoning",
      answer: "Análise concluída",
      queuedAt: "2026-08-23T10:00:00.000Z",
      startedAt: "2026-08-23T10:00:01.000Z",
      durationMs: 1234,
      threadMode: "persistent",
    });
    const reloaded = new ConversationJournal(directory);
    assert.equal(reloaded.append({ role: "user", text: "Continua", source: "typed" }).seq, 3);
    assert.match(reloaded.readSince(1).text, /ASSISTANT: Olá!/);
    assert.match(reloaded.readSince(1).text, /USER: Continua/);
    assert.equal(reloaded.readAll()[1].consultJobId, "call-1");
    assert.equal(reloaded.readConsults()[0].model, "gpt-5.6-luna");
    assert.equal(reloaded.readConsults()[0].reasoningEffort, "low");
    assert.equal(reloaded.readConsults()[0].durationMs, 1234);
    const gate = reloaded.appendResponseGate({
      at: "2026-08-23T10:00:02.000Z",
      decision: "RESPOND",
      latencyMs: 183,
      speaker: "@pessoa",
      text: "Mira, o que achas?",
      responseStatus: "completed",
      outputTokens: 6,
      outputTextTokens: 6,
      maxOutputTokens: 64,
    });
    assert.deepEqual(gate, {
      at: "2026-08-23T10:00:02.000Z",
      decision: "RESPOND",
      latencyMs: 183,
      speaker: "@pessoa",
      text: "Mira, o que achas?",
      responseStatus: "completed",
      outputTokens: 6,
      outputTextTokens: 6,
      maxOutputTokens: 64,
    });
    assert.deepEqual(reloaded.readResponseGates(), [gate]);
    assert.throws(() => reloaded.appendResponseGate({ decision: "MAYBE", latencyMs: 1 }));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a thread principal é durável e sincroniza conversa pendente", async () => {
  const directory = temporaryDirectory();
  const client = new FakeCodexClient();
  try {
    const brain = new CodexBrain({ cwd: directory, dataDir: directory, client });
    brain.journal.append({ role: "user", text: "Lembra-te desta nuance", source: "voice" });
    const result = await brain.consult({ jobId: "job-1", kind: "reasoning", question: "O que devo responder?" });
    assert.equal(result.answer, "Orientação persistente do Codex.");
    const start = client.requests.find((entry) => entry.method === "thread/start");
    assert.equal(start.params.ephemeral, false);
    assert.equal(start.params.model, "gpt-5.6-luna");
    assert.equal(start.params.sandbox, "read-only");
    assert.equal(start.params.config.web_search, "live");
    assert.match(client.turns[0].prompt, /Lembra-te desta nuance/);
    assert.match(client.turns[0].prompt, /DATA ATUAL EM LISBOA: \d{4}-\d{2}-\d{2}/);
    assert.deepEqual(client.turns[0].options, { model: "gpt-5.6-luna", effort: "low" });
    const evaluation = brain.evaluation();
    assert.equal(evaluation.consults[0].question, "O que devo responder?");
    assert.equal(evaluation.consults[0].answer, "Orientação persistente do Codex.");
    assert.equal(evaluation.consults[0].threadMode, "persistent");
    const state = JSON.parse(readFileSync(join(directory, "codex-state.json"), "utf8"));
    assert.equal(state.threadId, "thread-1");
    assert.equal(state.syncedSeq, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a pesquisa usa um fork efémero e persiste apenas o resultado resumido", async () => {
  const directory = temporaryDirectory();
  const client = new FakeCodexClient();
  let releasePersistence;
  client.persistenceGate = new Promise((resolve) => { releasePersistence = resolve; });
  try {
    const brain = new CodexBrain({ cwd: directory, dataDir: directory, client });
    brain.journal.append({ role: "user", text: "Pesquisa esta notícia", source: "voice" });
    const result = await brain.consult({ jobId: "job-2", kind: "research", question: "Qual é a notícia atual?" });
    assert.match(result.answer, /https:\/\/example\.com/);
    assert.equal(result.persistenceMode, "background");
    const fork = client.requests.find((entry) => entry.method === "thread/fork");
    assert.equal(fork.params.ephemeral, true);
    assert.equal(fork.params.model, "gpt-5.6-luna");
    assert.equal(client.turns[0].threadId.startsWith("research-"), true);
    assert.equal(client.turns[1].threadId, "thread-1");
    assert.deepEqual(client.turns[0].options, { model: "gpt-5.6-luna", effort: "low" });
    assert.deepEqual(client.turns[1].options, { model: "gpt-5.6-luna", effort: "low" });
    assert.match(readFileSync(join(directory, "research.jsonl"), "utf8"), /Resultado pesquisado/);
    const consultLog = readFileSync(join(directory, "codex-consults.jsonl"), "utf8");
    assert.match(consultLog, /"threadMode":"research-fork"/);
    assert.match(consultLog, /"persistenceMode":"background"/);
    assert.match(consultLog, /Resultado pesquisado/);
    const stateBeforeSync = JSON.parse(readFileSync(join(directory, "codex-state.json"), "utf8"));
    assert.equal(stateBeforeSync.syncedSeq, 0);
    releasePersistence();
    await brain.close();
    const stateAfterSync = JSON.parse(readFileSync(join(directory, "codex-state.json"), "utf8"));
    assert.equal(stateAfterSync.syncedSeq, 1);
  } finally {
    releasePersistence?.();
    rmSync(directory, { recursive: true, force: true });
  }
});
