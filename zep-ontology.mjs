import { entityFields } from "@getzep/zep-cloud";

const participantSources = ["User", "Assistant", "ParticipantProfile"];
const sourceTargets = (sources, targets) => sources.flatMap((source) => targets.map((target) => ({ source, target })));

export const ZEP_DEBATE_ENTITIES = {
  ParticipantProfile: {
    description: "A distinct external human participant in a multi-speaker discussion. Identity follows stable X handle or speaker ID, never display name alone.",
    fields: {
      stable_identity: entityFields.text("The canonical X handle or stable X speaker ID used to keep this participant distinct across sessions."),
      aliases: entityFields.text("Known display names or aliases, treated as secondary mutable labels."),
    },
  },
  DiscussionTopic: {
    description: "A concrete subject being discussed or debated, distinct from a participant stance.",
    fields: {
      scope: entityFields.text("A concise description of the precise issue under discussion."),
    },
  },
  DebatePosition: {
    description: "A specific position, opinion, conclusion, or stance held in a discussion, including historical and superseded positions.",
    fields: {
      stance: entityFields.text("A faithful concise statement of the position actually expressed."),
      temporal_status: entityFields.text("Whether the position is current, historical, rejected, or superseded when the conversation supports that distinction."),
    },
  },
  LogicalArgument: {
    description: "A reason, justification, piece of evidence, or claim used to support, challenge, or answer a position or another argument.",
    fields: {
      argument: entityFields.text("A faithful concise rendering of the reason, evidence, or claim actually expressed."),
    },
  },
  UnresolvedQuestion: {
    description: "A relevant question or point of uncertainty left unanswered or unresolved in the discussion.",
    fields: {
      question: entityFields.text("The unresolved question in faithful and neutral terms."),
      resolution_status: entityFields.text("Whether it remains open or was later resolved, when explicitly supported by conversation evidence."),
    },
  },
};

export const ZEP_DEBATE_EDGES = {
  HOLDS_POSITION: {
    description: "A participant, the primary User, or the Assistant explicitly holds or held a DebatePosition.",
    fields: { support: entityFields.text("Brief evidence from the conversation for attributing the position to this speaker.") },
    sourceTargets: sourceTargets(participantSources, ["DebatePosition"]),
  },
  SUPPORTS_ARGUMENT: {
    description: "A participant, the primary User, or the Assistant expressed or endorsed a LogicalArgument.",
    fields: { support: entityFields.text("Brief evidence that this speaker expressed or endorsed the argument.") },
    sourceTargets: sourceTargets(participantSources, ["LogicalArgument"]),
  },
  CHALLENGES_CLAIM: {
    description: "A speaker's argument or position explicitly challenges a position or argument expressed in the discussion.",
    fields: { challenge: entityFields.text("The explicit point of disagreement or challenge, without adding a fallacy label unless stated.") },
    sourceTargets: [
      ...sourceTargets(["LogicalArgument", "DebatePosition"], ["LogicalArgument", "DebatePosition"]),
    ],
  },
  RESPONDS_TO: {
    description: "A LogicalArgument directly answers, rebuts, qualifies, or otherwise responds to an earlier LogicalArgument.",
    fields: { response: entityFields.text("How the later argument responds to the earlier one, grounded in what was said.") },
    sourceTargets: [{ source: "LogicalArgument", target: "LogicalArgument" }],
  },
  ADDRESSES_TOPIC: {
    description: "A position, argument, or unresolved question concerns a specific DiscussionTopic.",
    fields: { relevance: entityFields.text("The direct connection between this item and the discussion topic.") },
    sourceTargets: sourceTargets(["DebatePosition", "LogicalArgument", "UnresolvedQuestion"], ["DiscussionTopic"]),
  },
  LEADS_TO_QUESTION: {
    description: "A position or argument gives rise to a relevant UnresolvedQuestion.",
    fields: { connection: entityFields.text("Why this position or argument leaves the question open.") },
    sourceTargets: sourceTargets(["DebatePosition", "LogicalArgument"], ["UnresolvedQuestion"]),
  },
  RAISES_QUESTION: {
    description: "A participant, the primary User, or the Assistant explicitly raised an UnresolvedQuestion.",
    fields: { support: entityFields.text("Brief evidence that this speaker raised the question.") },
    sourceTargets: sourceTargets(participantSources, ["UnresolvedQuestion"]),
  },
};
