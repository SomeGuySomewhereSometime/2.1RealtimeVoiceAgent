import test from "node:test";
import assert from "node:assert/strict";

import { ZEP_DEBATE_EDGES, ZEP_DEBATE_ENTITIES } from "../zep-ontology.mjs";

test("a ontology completa liga User, Assistant e participantes ao debate", () => {
  assert.deepEqual(Object.keys(ZEP_DEBATE_ENTITIES).sort(), [
    "DebatePosition",
    "DiscussionTopic",
    "LogicalArgument",
    "ParticipantProfile",
    "UnresolvedQuestion",
  ]);
  for (const source of ["User", "Assistant", "ParticipantProfile"]) {
    assert.ok(ZEP_DEBATE_EDGES.HOLDS_POSITION.sourceTargets.some(
      (pair) => pair.source === source && pair.target === "DebatePosition",
    ));
    assert.ok(ZEP_DEBATE_EDGES.SUPPORTS_ARGUMENT.sourceTargets.some(
      (pair) => pair.source === source && pair.target === "LogicalArgument",
    ));
    assert.ok(ZEP_DEBATE_EDGES.RAISES_QUESTION.sourceTargets.some(
      (pair) => pair.source === source && pair.target === "UnresolvedQuestion",
    ));
  }
});
