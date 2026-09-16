export * from "./nvidia.js";

// Module-format default handler. The Worker is reached only through its `GatekeeperVendor` service
// entrypoint; this export exists because a Durable Object migration requires an ES Module Worker,
// which wrangler only recognizes when a default export is present.
export default {
  async fetch(): Promise<Response> {
    return new Response("NVIDIA Gatekeeper worker is running.", {
      headers: { "content-type": "text/plain" },
    });
  },
};
