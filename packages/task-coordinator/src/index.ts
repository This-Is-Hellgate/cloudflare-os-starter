// The trusted coordinator gadget (plan Task 4.2): packaged as a versioned installable artifact.
// It registers persistent restored hooks, spawns governed callable agents with typed task
// facades, and restores across restart. Final authority checks remain in the provider/runtime
// Workers — a gadget wrapper alone is not a trust boundary.
export * from "./profiles.js";
