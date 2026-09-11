interface Env {
  HF_TOKEN: string;
  HF_RESOURCE_URL?: string;
  HF_INFERENCE_MODEL?: string;
  HF_INFERENCE_PROVIDER?: string;
}
declare namespace Cloudflare {
  interface GlobalProps {
    mainModule: typeof import("./index");
    durableNamespaces: "HuggingFaceGatekeeper";
  }
}
