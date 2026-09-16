// Coordinator agent profiles (plan §5.1): owner-reviewed spawner profiles containing ONLY task
// facade resources and scoped task evidence. None exposes private apply callbacks.
//
// Profile rules:
//  - researcher: read/compute
//  - builder:    read/compute/propose
//  - evaluator:  read/evaluate
//  - operator:   read/propose
// Every spawned agent's authority is the intersection of the profile policy and the parent
// grant (strict reduction is proven in the runtime's authority.ts); the profile alone is not
// the boundary — final authority checks remain in the provider/runtime Workers.

export interface CoordinatorProfile {
  name: "researcher" | "builder" | "evaluator" | "operator";
  /** Task-facade methods the child may exercise, by family. */
  allowedFamilies: readonly ("read" | "compute" | "propose" | "evaluate")[];
  /** The typed interface the child implements (SpawnCallableOptions.mainType source). */
  childTypes: string;
  childMainType: string;
}

const CHILD_INTERFACE_BASE = `import type { RpcStub } from "capnweb";

/** The evidence the child reports back to the parent (persisted as a ChildResult). */
export interface ChildCompletion {
  /** Durable completion report: the child calls this exactly once at the end. */
  complete(result: { status: "completed" | "failed" | "cancelled"; summary: string; evidenceIds: string[] }): Promise<void>;
}
`;

export const PROFILES: Record<CoordinatorProfile["name"], CoordinatorProfile> = {
  researcher: {
    name: "researcher",
    allowedFamilies: ["read", "compute"],
    childMainType: "ResearcherAgent",
    childTypes: CHILD_INTERFACE_BASE + `
/** A read/compute researcher: gathers evidence, never proposes writes. */
export interface ResearcherAgent {
  investigate(task: { objective: string; facade: RpcStub<object>; done: RpcStub<ChildCompletion> }): Promise<void>;
}
`,
  },
  builder: {
    name: "builder",
    allowedFamilies: ["read", "compute", "propose"],
    childMainType: "BuilderAgent",
    childTypes: CHILD_INTERFACE_BASE + `
/** A read/compute/propose builder: drafts artifacts and governed proposals, never applies. */
export interface BuilderAgent {
  build(task: { objective: string; facade: RpcStub<object>; done: RpcStub<ChildCompletion> }): Promise<void>;
}
`,
  },
  evaluator: {
    name: "evaluator",
    allowedFamilies: ["read", "evaluate"],
    childMainType: "EvaluatorAgent",
    childTypes: CHILD_INTERFACE_BASE + `
/** An evaluator: reads evidence and produces scored judgments with bounded datasets. */
export interface EvaluatorAgent {
  evaluate(task: { objective: string; facade: RpcStub<object>; done: RpcStub<ChildCompletion> }): Promise<void>;
}
`,
  },
  operator: {
    name: "operator",
    allowedFamilies: ["read", "propose"],
    childMainType: "OperatorAgent",
    childTypes: CHILD_INTERFACE_BASE + `
/** An operator: prepares governed proposals from evidence; never applies or computes heavily. */
export interface OperatorAgent {
  coordinate(task: { objective: string; facade: RpcStub<object>; done: RpcStub<ChildCompletion> }): Promise<void>;
}
`,
  },
};

/** The typed child interface a profile spawns with (SpawnCallableOptions-compatible). */
export function childSpawnOptions(profile: CoordinatorProfile): { types: string; mainType: string } {
  return { types: profile.childTypes, mainType: profile.childMainType };
}
