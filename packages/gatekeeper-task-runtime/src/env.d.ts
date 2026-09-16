interface Env {
  /** The task identity this DO instance carries (set via props at instantiation). */
  TASK_ID?: string;
  TASK_TITLE?: string;
  TASK_OWNER?: string;
  TASK_WORKSPACE?: string;
  /** Task lifetime cap; the runtime never exceeds 24 hours regardless of this value. */
  TASK_LIFETIME_MS?: string;
  /** Optional limit overrides; the runtime clamps to its own defaults' ceilings. */
  TASK_MAX_RUNS?: string;
  TASK_MAX_CHILDREN?: string;
  TASK_MAX_DEPTH?: string;
  TASK_MAX_CHECKPOINT_CHARS?: string;
  TASK_MAX_EVIDENCE_CHARS?: string;
}
