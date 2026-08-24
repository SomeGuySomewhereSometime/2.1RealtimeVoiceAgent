import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  MiraResponseGate,
  RESPONSE_GATE_PROMPT,
  RESPONSE_GATE_PURPOSE,
  parseGateDecision,
} from "../public/response-gate.js";

function createHarness() {
  const sent = [];
  const decisions = [];
  const logs = [];
  const timers = [];
  let now = 1_000;
  const gate = new MiraResponseGate({
    send: (event) => sent.push(event),
    onDecision: (decision) => decisions.push(decision),
    onLog: (row) => logs.push(row),
    now: () => now,
    setTimer: (callback) => {
      const timer = { callback, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => { timer.cleared = true; },
    timeoutMs: 500,
  });
  return {
    gate,
    sent,
    decisions,
    logs,
    timers,
    advance(milliseconds) { now += milliseconds; },
    createResponse() {
      const create = sent.findLast((event) => event.type === "response.create");
      const response = {
        id: `resp_${create.response.metadata.gate_id}`,
        metadata: create.response.metadata,
      };
      assert.equal(gate.handleResponseCreated(response), true);
      return response;
    },
  };
}

function completedResponse(response, text, status = "completed") {
  return {
    ...response,
    status,
    output: [{
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text }],
    }],
  };
}

test("o gate usa uma response textual out-of-band do próprio Realtime, sem ferramentas", () => {
  const harness = createHarness();
  harness.gate.request({ itemId: "item_voice_1" });
  assert.equal(harness.sent.length, 1);
  const event = harness.sent[0];
  assert.equal(event.type, "response.create");
  assert.equal(event.response.conversation, "none");
  assert.deepEqual(event.response.output_modalities, ["text"]);
  assert.deepEqual(event.response.tools, []);
  assert.equal(event.response.tool_choice, "none");
  assert.equal(event.response.max_output_tokens, 64);
  assert.equal(event.response.metadata.response_purpose, RESPONSE_GATE_PURPOSE);
  assert.match(RESPONSE_GATE_PROMPT, /whether Mira should speak/);
  assert.match(RESPONSE_GATE_PROMPT, /When genuinely ambiguous, prefer IGNORE/);
  assert.equal("input" in event.response, false, "sem input próprio, usa o contexto recente da conversa");
});

test("RESPOND autoriza exatamente uma resposta normal mesmo com response.done duplicado", () => {
  const harness = createHarness();
  harness.gate.request({ itemId: "item_voice_2" });
  const response = harness.createResponse();
  harness.advance(183);
  assert.equal(harness.gate.handleResponseDone(completedResponse(response, "RESPOND")), true);
  assert.equal(harness.gate.handleResponseDone(completedResponse(response, "RESPOND")), true);
  assert.equal(harness.decisions.length, 1);
  assert.equal(harness.decisions[0].decision, "RESPOND");
  assert.equal(harness.logs[0].latencyMs, 183);
  assert.equal(harness.gate.pending, false);
});

test("IGNORE termina silenciosamente e não autoriza resposta", () => {
  const harness = createHarness();
  harness.gate.request();
  const response = harness.createResponse();
  harness.gate.handleResponseDone(completedResponse(response, "IGNORE"));
  assert.deepEqual(harness.decisions.map((entry) => entry.decision), ["IGNORE"]);
  assert.equal(harness.sent.filter((event) => event.type === "response.create").length, 1);
});

test("output inválido, falha e timeout fazem fail-closed para IGNORE", () => {
  assert.equal(parseGateDecision("respond"), "RESPOND");
  assert.equal(parseGateDecision(" IGNORE\n"), "IGNORE");
  assert.equal(parseGateDecision("RESPOND porque..."), "");

  const invalid = createHarness();
  invalid.gate.request();
  invalid.gate.handleResponseDone(completedResponse(invalid.createResponse(), "Talvez"));
  assert.equal(invalid.decisions[0].decision, "IGNORE");
  assert.match(invalid.logs[0].error, /invalid response gate output/);

  const failed = createHarness();
  failed.gate.request();
  failed.gate.handleResponseDone({
    ...completedResponse(failed.createResponse(), "", "incomplete"),
    status_details: { reason: "max_output_tokens" },
    max_output_tokens: 64,
    usage: {
      output_tokens: 64,
      output_token_details: { text_tokens: 0, reasoning_tokens: 64 },
    },
  });
  assert.equal(failed.decisions[0].decision, "IGNORE");
  assert.match(failed.logs[0].error, /status incomplete/);
  assert.equal(failed.logs[0].responseStatus, "incomplete");
  assert.equal(failed.logs[0].statusReason, "max_output_tokens");
  assert.equal(failed.logs[0].outputTokens, 64);
  assert.equal(failed.logs[0].outputTextTokens, 0);
  assert.equal(failed.logs[0].reasoningTokens, 64);
  assert.equal(failed.logs[0].maxOutputTokens, 64);

  const timedOut = createHarness();
  timedOut.gate.request();
  timedOut.timers[0].callback();
  assert.equal(timedOut.decisions[0].decision, "IGNORE");
  assert.match(timedOut.logs[0].error, /timed out/);
});

test("nova fala cancela e reforma o gate sem aceitar resultados antigos", () => {
  const harness = createHarness();
  harness.gate.request({ itemId: "old" });
  const oldResponse = harness.createResponse();
  assert.equal(harness.gate.abandon("new speech started"), true);
  assert.equal(harness.sent.at(-1).type, "response.cancel");
  assert.equal(harness.sent.at(-1).response_id, oldResponse.id);
  harness.gate.request({ itemId: "new" });
  assert.equal(harness.gate.handleResponseDone(completedResponse(oldResponse, "RESPOND")), true);
  assert.equal(harness.decisions.length, 1);
  assert.equal(harness.decisions[0].decision, "IGNORE");
  assert.equal(harness.gate.pending, true);
});

test("a transcrição associada é incluída no log quando chega antes da decisão", () => {
  const harness = createHarness();
  harness.gate.request({ itemId: "item_voice_3" });
  assert.equal(harness.gate.noteTranscript({ itemId: "outro", text: "texto errado" }), false);
  assert.equal(harness.gate.noteTranscript({ itemId: "item_voice_3", text: "Mira, o que achas?" }), true);
  const response = harness.createResponse();
  harness.gate.handleResponseDone(completedResponse(response, "RESPOND"));
  assert.equal(harness.logs[0].text, "Mira, o que achas?");
});

test("a integração do browser separa voz, texto, XCAP, gate e tool calls", () => {
  const client = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  const speechStopped = client.slice(
    client.indexOf('type === "input_audio_buffer.speech_stopped"'),
    client.indexOf('type === "response.created"', client.indexOf('type === "input_audio_buffer.speech_stopped"')),
  );
  assert.match(speechStopped, /responseGate\.request/);
  assert.doesNotMatch(speechStopped, /queuedResponse\s*=\s*true/);
  assert.doesNotMatch(speechStopped, /maybeCreateResponse/);

  const typed = client.slice(client.indexOf("function sendText"), client.indexOf("function discoverFunctionCalls"));
  assert.match(typed, /queuedResponse\s*=\s*true/);
  assert.match(typed, /maybeCreateResponse\(\)/);
  assert.doesNotMatch(typed, /responseGate\.request/);

  const xcap = client.slice(client.indexOf("function sendXSpaceCaption"), client.indexOf("function handleRealtimeEvent"));
  assert.doesNotMatch(xcap, /response\.create/);
  assert.doesNotMatch(xcap, /queuedResponse/);

  const tool = client.slice(client.indexOf("function completeToolCall"), client.indexOf("function recordJournal"));
  assert.match(tool, /function_call_output/);
  assert.match(tool, /queuedResponse\s*=\s*true/);
  assert.match(tool, /responseGate\.pending/);

  const handlerPrefix = client.slice(client.indexOf("function handleRealtimeEvent"), client.indexOf('if (type === "input_audio_buffer.speech_started"'));
  assert.match(handlerPrefix, /handleResponseDone\(event\.response\)\) return/);
  assert.match(handlerPrefix, /handleTextEvent\(event\)\) return/);
});

test("memória final permanece separada do gate e retrieval só atrasa RESPOND", () => {
  const client = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  const finalInput = client.slice(
    client.indexOf('type === "conversation.item.input_audio_transcription.completed"'),
    client.indexOf('type === "error"', client.indexOf('type === "conversation.item.input_audio_transcription.completed"')),
  );
  assert.match(finalInput, /rememberZepTurn/);
  assert.match(finalInput, /finalText/);
  assert.doesNotMatch(finalInput, /event\.delta/);

  const decision = client.slice(
    client.indexOf("async function handleGateDecision"),
    client.indexOf("function prepareZepTurn"),
  );
  const respond = decision.slice(decision.indexOf('result.decision === "RESPOND"'), decision.indexOf("} else {"));
  const ignore = decision.slice(decision.indexOf("} else {"));
  assert.match(respond, /await waitForZepTurn/);
  assert.match(respond, /realtimeZepContext\.replace/);
  assert.match(respond, /queuedResponse\s*=\s*true/);
  assert.doesNotMatch(ignore, /await waitForZepTurn/);
  assert.match(ignore, /pendingZepTurns\.delete/);
  assert.match(decision, /result\.gateId !== latestGateId/);

  const memoryRequest = client.slice(
    client.indexOf("async function rememberZepTurn"),
    client.indexOf("function discoverFunctionCalls"),
  );
  assert.match(memoryRequest, /final:\s*true/);
  assert.match(memoryRequest, /turnId/);
  assert.doesNotMatch(memoryRequest, /retrieved_long_term_memory|ZEP_CONTEXT_PREAMBLE/);
});
