export * from "./contracts.js";
export * from "./storage.js";
export * from "./authority.js";
export * from "./governed-task-do.js";

export default {
  async fetch(): Promise<Response> {
    return new Response("Task runtime worker is running.", { headers: { "content-type": "text/plain" } });
  },
};
