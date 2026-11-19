import {
  AuthOrchestrationOperateScope,
  AuthSourceControlWriteScope,
  EnvironmentId,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const laptop = EnvironmentId.make("laptop");
const server = EnvironmentId.make("server");

const state = vi.hoisted(() => ({
  granted: new Set<string>(),
  serverConnected: true,
}));

vi.mock("@effect/atom-react", () => ({ useAtomValue: () => new Map() }));
vi.mock("../rpc/atomRegistry", () => ({
  appAtomRegistry: {
    get: () =>
      new Map(
        (["laptop", "server"] as const).map((id) => [
          id,
          {
            entry: { target: { label: id } },
            connection: {
              phase: id === "server" && !state.serverConnected ? "offline" : "connected",
            },
            serverConfig: {
              providers: [],
              scratchWorkspaceRoot: "/scratch",
              environment: { capabilities: {} },
            },
          },
        ]),
      ),
  },
}));
vi.mock("../state/presentation", () => ({
  environmentPresentations: { presentationsWithProvidersAtom: {} },
}));
vi.mock("../state/session", () => ({
  readEnvironmentScope: (environmentId: string, scope: string) =>
    state.granted.has(`${environmentId}:${scope}`),
  useEnvironmentsWithScope: () => new Set(),
}));

const project = (environmentId: EnvironmentId, id: string) => ({
  environmentId,
  id: ProjectId.make(id),
  title: id,
  workspaceRoot: `/work/${id}`,
  repositoryIdentity: null,
  isScratch: false,
});
vi.mock("../state/entities", () => ({
  readThreadShell: () => ({ environmentId: laptop, projectId: "source" }),
  readProject: () => project(laptop, "source"),
  readProjects: () => [project(laptop, "source")],
}));

import { canOfferContinueOn } from "./handoffMachines";

const threadRef = { environmentId: laptop, threadId: ThreadId.make("thread") };
const grant = (environmentId: EnvironmentId, ...scopes: ReadonlyArray<string>) => {
  for (const scope of scopes) state.granted.add(`${environmentId}:${scope}`);
};

describe("canOfferContinueOn", () => {
  beforeEach(() => {
    state.granted.clear();
    state.serverConnected = true;
  });

  it("offers the handoff when the connection can change the thread and a machine can take it", () => {
    grant(laptop, AuthOrchestrationOperateScope);
    grant(server, AuthOrchestrationOperateScope, AuthSourceControlWriteScope);
    expect(canOfferContinueOn(threadRef)).toBe(true);
  });

  it("leaves it out when the connection cannot change the thread on its own machine", () => {
    grant(server, AuthOrchestrationOperateScope, AuthSourceControlWriteScope);
    expect(canOfferContinueOn(threadRef)).toBe(false);
  });

  it("leaves it out when no other machine can take the thread", () => {
    grant(laptop, AuthOrchestrationOperateScope);
    grant(server, AuthOrchestrationOperateScope);
    state.serverConnected = false;
    expect(canOfferContinueOn(threadRef)).toBe(false);
  });
});
