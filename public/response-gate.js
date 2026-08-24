export const RESPONSE_GATE_PURPOSE = "mira_response_gate";
export const RESPONSE_GATE_TIMEOUT_MS = 3_000;

export const RESPONSE_GATE_PROMPT = `You are deciding whether Mira should speak.

There may be multiple people in the conversation, and much of the
conversation may be between humans rather than directed at Mira.

Determine whether the latest speaker is:
- directly addressing Mira, or
- clearly continuing an interaction with Mira.

RESPOND if the latest utterance is clearly intended for Mira,
including short follow-ups or answers to something Mira just said
or asked.

IGNORE if the speaker is talking to another person, speaking generally,
making a side comment, reacting to someone else, or if the utterance
does not require Mira to participate.

Do not assume that a question is addressed to Mira merely because
Mira can hear it.

Use recent conversation context, including [XCAP] speaker labels when
present, to understand who is speaking and what they are continuing.

When genuinely ambiguous, prefer IGNORE.

Return only:
RESPOND
or
IGNORE`;

let fallbackGateSequence = 0;

function createGateId() {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return `gate_${uuid.replaceAll("-", "")}`;
  fallbackGateSequence += 1;
  return `gate_${Date.now()}_${fallbackGateSequence}`;
}

export function parseGateDecision(value) {
  const decision = String(value || "").trim().toUpperCase();
  return decision === "RESPOND" || decision === "IGNORE" ? decision : "";
}

export function responseOutputText(response) {
  if (!Array.isArray(response?.output)) return "";
  const parts = [];
  for (const item of response.output) {
    if (!Array.isArray(item?.content)) continue;
    for (const content of item.content) {
      const text = typeof content?.text === "string"
        ? content.text
        : typeof content?.transcript === "string" ? content.transcript : "";
      if (text) parts.push(text);
    }
  }
  return parts.join("");
}

function gateMetadata(value) {
  return value?.metadata && typeof value.metadata === "object" ? value.metadata : {};
}

function responseTelemetry(response) {
  const usage = response?.usage && typeof response.usage === "object" ? response.usage : {};
  const tokenDetails = usage.output_token_details && typeof usage.output_token_details === "object"
    ? usage.output_token_details
    : usage.output_tokens_details && typeof usage.output_tokens_details === "object"
      ? usage.output_tokens_details
      : {};
  const tokenCount = (value) => Number.isFinite(Number(value))
    ? Math.max(0, Math.round(Number(value)))
    : undefined;
  const responseStatus = String(response?.status || "").trim();
  const statusReason = String(
    response?.status_details?.reason || response?.incomplete_details?.reason || "",
  ).trim();
  return {
    ...(responseStatus ? { responseStatus } : {}),
    ...(statusReason ? { statusReason } : {}),
    ...(tokenCount(usage.output_tokens) !== undefined
      ? { outputTokens: tokenCount(usage.output_tokens) }
      : {}),
    ...(tokenCount(tokenDetails.text_tokens) !== undefined
      ? { outputTextTokens: tokenCount(tokenDetails.text_tokens) }
      : {}),
    ...(tokenCount(tokenDetails.audio_tokens) !== undefined
      ? { outputAudioTokens: tokenCount(tokenDetails.audio_tokens) }
      : {}),
    ...(tokenCount(tokenDetails.reasoning_tokens) !== undefined
      ? { reasoningTokens: tokenCount(tokenDetails.reasoning_tokens) }
      : {}),
    ...(tokenCount(response?.max_output_tokens) !== undefined
      ? { maxOutputTokens: tokenCount(response.max_output_tokens) }
      : {}),
  };
}

export class MiraResponseGate {
  #send;
  #onDecision;
  #onLog;
  #now;
  #setTimer;
  #clearTimer;
  #timeoutMs;
  #active;
  #retiredResponseIds = new Set();
  #retiredGateIds = new Set();

  constructor({
    send,
    onDecision = () => {},
    onLog = () => {},
    now = () => Date.now(),
    setTimer = (callback, delay) => setTimeout(callback, delay),
    clearTimer = (timer) => clearTimeout(timer),
    timeoutMs = RESPONSE_GATE_TIMEOUT_MS,
  }) {
    if (typeof send !== "function") throw new Error("MiraResponseGate requires a send callback.");
    this.#send = send;
    this.#onDecision = onDecision;
    this.#onLog = onLog;
    this.#now = now;
    this.#setTimer = setTimer;
    this.#clearTimer = clearTimer;
    this.#timeoutMs = Math.max(250, Number(timeoutMs) || RESPONSE_GATE_TIMEOUT_MS);
  }

  get pending() {
    return Boolean(this.#active);
  }

  request(turn = {}) {
    if (this.#active) this.abandon("superseded by a newer voice turn");
    const gateId = createGateId();
    const createEventId = `mira_gate_create_${gateId.slice(5)}`;
    this.#active = {
      gateId,
      createEventId,
      responseId: "",
      itemId: String(turn.itemId || ""),
      speaker: String(turn.speaker || "").trim(),
      text: String(turn.text || "").trim(),
      output: "",
      startedAt: this.#now(),
      timer: undefined,
    };
    try {
      this.#send({
        event_id: createEventId,
        type: "response.create",
        response: {
          conversation: "none",
          output_modalities: ["text"],
          instructions: RESPONSE_GATE_PROMPT,
          tools: [],
          tool_choice: "none",
          max_output_tokens: 64,
          metadata: {
            response_purpose: RESPONSE_GATE_PURPOSE,
            gate_id: gateId,
          },
        },
      });
      this.#active.timer = this.#setTimer(() => {
        if (!this.#active || this.#active.gateId !== gateId) return;
        this.abandon("response gate timed out");
      }, this.#timeoutMs);
    } catch (error) {
      this.#finish("IGNORE", error instanceof Error ? error.message : "response gate could not start");
    }
    return gateId;
  }

  noteTranscript({ itemId = "", text = "", speaker = "" } = {}) {
    if (!this.#active) return false;
    const normalizedItemId = String(itemId || "");
    if (this.#active.itemId && normalizedItemId && this.#active.itemId !== normalizedItemId) return false;
    const normalizedText = String(text || "").trim();
    const normalizedSpeaker = String(speaker || "").trim();
    if (normalizedText) this.#active.text = normalizedText;
    if (normalizedSpeaker) this.#active.speaker = normalizedSpeaker;
    if (normalizedItemId && !this.#active.itemId) this.#active.itemId = normalizedItemId;
    return true;
  }

  handleResponseCreated(response) {
    const metadata = gateMetadata(response);
    const gateId = String(metadata.gate_id || "");
    const responseId = String(response?.id || "");
    const isGate = metadata.response_purpose === RESPONSE_GATE_PURPOSE
      || this.#retiredGateIds.has(gateId)
      || (this.#active && gateId === this.#active.gateId);
    if (!isGate) return false;
    if (responseId) this.#rememberResponseId(responseId);
    if (this.#active && gateId === this.#active.gateId) {
      this.#active.responseId = responseId;
    } else if (responseId) {
      this.#cancelResponse(responseId);
    }
    return true;
  }

  handleTextEvent(event) {
    const responseId = String(event?.response_id || event?.response?.id || "");
    if (!responseId || !this.#isKnownResponseId(responseId)) return false;
    if (this.#active?.responseId === responseId && typeof event.delta === "string") {
      this.#active.output += event.delta;
    }
    return true;
  }

  handleResponseDone(response) {
    const metadata = gateMetadata(response);
    const gateId = String(metadata.gate_id || "");
    const responseId = String(response?.id || "");
    const isActive = Boolean(this.#active) && (
      gateId === this.#active.gateId
      || (responseId && responseId === this.#active.responseId)
    );
    if (!isActive) {
      return metadata.response_purpose === RESPONSE_GATE_PURPOSE
        || this.#retiredGateIds.has(gateId)
        || this.#isKnownResponseId(responseId);
    }
    const completed = !response?.status || response.status === "completed";
    const output = responseOutputText(response) || this.#active.output;
    const parsed = completed ? parseGateDecision(output) : "";
    const telemetry = responseTelemetry(response);
    if (parsed) this.#finish(parsed, "", telemetry);
    else {
      const detail = completed
        ? `invalid response gate output: ${String(output || "<empty>").trim().slice(0, 120)}`
        : `response gate ended with status ${String(response?.status || "unknown")}`;
      this.#finish("IGNORE", detail, telemetry);
    }
    return true;
  }

  handleError(event) {
    if (!this.#active) return false;
    const relatedEventId = String(event?.error?.event_id || event?.event_id || "");
    const responseId = String(event?.error?.response_id || event?.response_id || "");
    if (relatedEventId !== this.#active.createEventId
      && (!responseId || responseId !== this.#active.responseId)) return false;
    const message = String(event?.error?.message || event?.error || "response gate failed");
    this.#finish("IGNORE", message);
    return true;
  }

  abandon(reason = "response gate abandoned") {
    if (!this.#active) return false;
    if (this.#active.responseId) this.#cancelResponse(this.#active.responseId);
    this.#finish("IGNORE", reason);
    return true;
  }

  reset() {
    if (!this.#active) return;
    if (this.#active.timer !== undefined) this.#clearTimer(this.#active.timer);
    this.#retire(this.#active);
    this.#active = undefined;
  }

  #finish(decision, error = "", telemetry = {}) {
    const gate = this.#active;
    if (!gate) return;
    if (gate.timer !== undefined) this.#clearTimer(gate.timer);
    this.#active = undefined;
    this.#retire(gate);
    const result = {
      at: new Date(this.#now()).toISOString(),
      decision: decision === "RESPOND" ? "RESPOND" : "IGNORE",
      latencyMs: Math.max(0, Math.round(this.#now() - gate.startedAt)),
      ...(gate.speaker ? { speaker: gate.speaker } : {}),
      ...(gate.text ? { text: gate.text } : {}),
      ...telemetry,
      ...(error ? { error: String(error).slice(0, 500) } : {}),
    };
    try { this.#onLog(result); } catch {}
    try { this.#onDecision({ ...result, gateId: gate.gateId, itemId: gate.itemId }); } catch {}
  }

  #retire(gate) {
    this.#retiredGateIds.add(gate.gateId);
    if (gate.responseId) this.#rememberResponseId(gate.responseId);
    while (this.#retiredGateIds.size > 128) this.#retiredGateIds.delete(this.#retiredGateIds.values().next().value);
  }

  #rememberResponseId(responseId) {
    if (!responseId) return;
    this.#retiredResponseIds.add(responseId);
    while (this.#retiredResponseIds.size > 128) {
      this.#retiredResponseIds.delete(this.#retiredResponseIds.values().next().value);
    }
  }

  #isKnownResponseId(responseId) {
    return Boolean(responseId) && (
      responseId === this.#active?.responseId || this.#retiredResponseIds.has(responseId)
    );
  }

  #cancelResponse(responseId) {
    try {
      this.#send({
        event_id: `mira_gate_cancel_${createGateId().slice(5)}`,
        type: "response.cancel",
        response_id: responseId,
      });
    } catch {}
  }
}
