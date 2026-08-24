#!/usr/bin/env node
import { ZepClient } from "@getzep/zep-cloud";

import { ZEP_DEBATE_EDGES, ZEP_DEBATE_ENTITIES } from "../zep-ontology.mjs";

const apply = process.argv.includes("--apply");
const apiKey = String(process.env.ZEP_API_KEY || "").trim();
const userId = String(process.env.ZEP_USER_ID || "").trim();

if (!apiKey) throw new Error("ZEP_API_KEY is required to inspect the Zep ontology.");
if (apply && !userId) throw new Error("ZEP_USER_ID is required for an explicit user-scoped ontology update.");

const client = new ZepClient({ apiKey });
let current;
try {
  current = await client.graph.listEntityTypes(userId ? { userId } : {}, { maxRetries: 0 });
} catch (error) {
  if (!userId || Number(error?.statusCode || error?.status || 0) !== 404) throw error;
  current = { entityTypes: [], edgeTypes: [] };
}
const entityNames = (current.entityTypes || []).map((item) => item.name).filter(Boolean).sort();
const edgeNames = (current.edgeTypes || []).map((item) => item.name).filter(Boolean).sort();
const requiredEntities = Object.keys(ZEP_DEBATE_ENTITIES).sort();
const requiredEdges = Object.keys(ZEP_DEBATE_EDGES).sort();
const missingEntities = requiredEntities.filter((name) => !entityNames.includes(name));
const missingEdges = requiredEdges.filter((name) => !edgeNames.includes(name));

console.log(JSON.stringify({
  target: userId ? { userId } : { project: true },
  current: { entities: entityNames, edges: edgeNames },
  required: { entities: requiredEntities, edges: requiredEdges },
  missing: { entities: missingEntities, edges: missingEdges },
}, null, 2));

if (!apply) {
  console.log("Inspection only. Re-run with --apply to replace the complete custom ontology for ZEP_USER_ID.");
  process.exit(0);
}

await client.graph.setOntology(
  ZEP_DEBATE_ENTITIES,
  ZEP_DEBATE_EDGES,
  { userIds: [userId] },
  { maxRetries: 0 },
);
console.log(`Applied the complete Mira debate ontology to Zep user ${userId}.`);
