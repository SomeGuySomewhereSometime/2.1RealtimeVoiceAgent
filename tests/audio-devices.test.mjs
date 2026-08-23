import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const client = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const page = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

test("a interface expõe seletores distintos de entrada e saída", () => {
  assert.match(page, /id="audio-input"/);
  assert.match(page, /id="audio-output"/);
  assert.match(page, /Microfone do sistema/);
  assert.match(page, /Saída do sistema/);
});

test("o microfone escolhido entra nas constraints WebRTC", () => {
  const acquireInput = client.slice(client.indexOf("function acquireInputStream"), client.indexOf("function waitForIce"));
  assert.match(acquireInput, /deviceId: \{ exact: audioInputSelect\.value \}/);
  assert.match(acquireInput, /echoCancellation: true/);
  assert.match(acquireInput, /noiseSuppression: true/);
});

test("a saída escolhida é aplicada ao elemento de áudio e pode mudar em direto", () => {
  assert.match(client, /remoteAudio\.setSinkId\(selected \|\| ""\)/);
  assert.match(client, /navigator\.mediaDevices\.selectAudioOutput\(\)/);
  assert.match(client, /addEventListener\("devicechange"/);
  const controls = client.slice(client.indexOf("function setControls"), client.indexOf("function acquireInputStream"));
  assert.match(controls, /audioInputSelect\.disabled = connected/);
  assert.doesNotMatch(controls, /audioOutputSelect\.disabled = connected/);
});
