// capnweb-validate/Vite replaces ?raw at build time; this keeps the agent-facing API sourced from
// the reviewed declaration file rather than duplicating it in the Worker.
import TYPES from "./types.d.ts?raw";
export default TYPES;
