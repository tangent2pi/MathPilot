import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { hostStateDirectory, hostStatePath, writeHostStateJson } from "./host-principal.ts";
import {
  parseInteractiveAdmissionReceipt,
  type InteractiveAdmissionReceipt,
} from "./interactive-receipt.ts";

const ATTEMPT_ID = /^agt_[A-Za-z0-9]{8,}$/;
const TOOL_CALL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/;
type JsonObject = Record<string, unknown>;
const object = (value: unknown): JsonObject | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;

export async function readActiveInteractiveReceipt(cwd: string): Promise<InteractiveAdmissionReceipt> {
  const directory = path.join(hostStateDirectory(cwd), "interactive-turns");
  const active: Array<{ updatedAt: number; receipt: InteractiveAdmissionReceipt }> = [];
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const marker = object(JSON.parse(await readFile(path.join(directory, entry.name), "utf8")) as unknown);
    if (!marker || !["sending", "sent", "completion_pending"].includes(String(marker.status))) continue;
    active.push({ updatedAt: Date.parse(String(marker.updated_at)), receipt: parseInteractiveAdmissionReceipt(marker.receipt) });
  }
  active.sort((left, right) => right.updatedAt - left.updatedAt);
  if (active.length !== 1) throw new Error("exactly one interactive turn must be active");
  return active[0]!.receipt;
}

export interface AcceptedTeachingArtifact {
  tool_call_id: string;
  artifact_ref: string;
  artifact_schema: string;
  summary: string;
}

type ArtifactState = {
  schema: "mathpilot.interactive-artifacts/v1";
  agent_attempt_id: string;
  artifacts: AcceptedTeachingArtifact[];
};

const artifactStatePath = (cwd: string): string => hostStatePath(cwd, "interactive-artifacts.json");

const parseArtifactState = (value: unknown): ArtifactState => {
  const raw = object(value);
  if (!raw || raw.schema !== "mathpilot.interactive-artifacts/v1"
    || typeof raw.agent_attempt_id !== "string" || !ATTEMPT_ID.test(raw.agent_attempt_id)
    || !Array.isArray(raw.artifacts) || raw.artifacts.length > 16) throw new Error("interactive artifact state is invalid");
  const artifacts = raw.artifacts.map((candidate) => {
    const artifact = object(candidate);
    if (!artifact || typeof artifact.tool_call_id !== "string" || !TOOL_CALL_ID.test(artifact.tool_call_id)
      || typeof artifact.artifact_ref !== "string" || artifact.artifact_ref.length > 1024
      || typeof artifact.artifact_schema !== "string" || artifact.artifact_schema.length > 1024
      || typeof artifact.summary !== "string" || !artifact.summary || artifact.summary.length > 1000) {
      throw new Error("interactive accepted artifact is invalid");
    }
    return artifact as unknown as AcceptedTeachingArtifact;
  });
  return { schema: raw.schema, agent_attempt_id: raw.agent_attempt_id, artifacts };
};

export async function recordAcceptedTeachingArtifact(
  cwd: string,
  agentAttemptId: string,
  artifact: AcceptedTeachingArtifact,
): Promise<void> {
  const previous = await readFile(artifactStatePath(cwd), "utf8")
    .then((json) => parseArtifactState(JSON.parse(json) as unknown))
    .catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    });
  const state: ArtifactState = previous?.agent_attempt_id === agentAttemptId
    ? previous
    : { schema: "mathpilot.interactive-artifacts/v1", agent_attempt_id: agentAttemptId, artifacts: [] };
  const existing = state.artifacts.find((entry) => entry.tool_call_id === artifact.tool_call_id);
  if (existing) {
    if (JSON.stringify(existing) !== JSON.stringify(artifact)) throw new Error("tool call artifact receipt changed");
    return;
  }
  if (state.artifacts.length >= 15) throw new Error("interactive artifact limit reached");
  await writeHostStateJson(cwd, "interactive-artifacts.json", JSON.stringify({
    ...state, artifacts: [...state.artifacts, artifact],
  }));
}

export async function readAcceptedTeachingArtifacts(
  cwd: string,
  agentAttemptId: string,
): Promise<AcceptedTeachingArtifact[]> {
  try {
    const state = parseArtifactState(JSON.parse(await readFile(artifactStatePath(cwd), "utf8")) as unknown);
    return state.agent_attempt_id === agentAttemptId ? state.artifacts : [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}
