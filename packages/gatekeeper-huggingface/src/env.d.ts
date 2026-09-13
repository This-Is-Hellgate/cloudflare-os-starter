interface Env {
  HF_TOKEN: string;
  HF_RESOURCE_URL?: string;
  HF_INFERENCE_MODEL?: string;
  HF_INFERENCE_PROVIDER?: string;
  /** Operator gate: when "true"/"1", approved Hugging Face write actions are executed against the Hub. */
  HF_ENABLE_WRITES?: string;
}
declare namespace Cloudflare {
  interface GlobalProps {
    mainModule: typeof import("./index");
    durableNamespaces: "HuggingFaceGatekeeper";
  }
}
