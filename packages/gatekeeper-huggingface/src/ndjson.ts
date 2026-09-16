// The Hugging Face Hub commit protocol (official implementation contract).
//
// Commits are submitted to `POST /api/{kind}s/{id}/commit/{revision}` as newline-delimited JSON:
// a `header` record, one `file` record per add/update, then one `deletedFile` record per deletion.
// Content-Type is `application/x-ndjson`. The endpoint returns `{"commitOid": "..."}` — the commit
// OID is the only accepted proof that the write landed; an absent OID means the outcome is
// unknown, never success.
//
// This module is deliberately free of `cloudflare:workers` imports so the fixture in
// __tests__/commit-ndjson.test.ts drives the REAL serializer. V1 authority: UTF-8 text
// add/update and file deletion only. Binary and LFS payloads are unsupported and rejected —
// they would need the separate LFS upload protocol and are not silently approximated.

/** The Content-Type the official Hub commit endpoint requires. */
export const NDJSON_CONTENT_TYPE = "application/x-ndjson";

/** The maximum number of changed files in one proposed commit. */
export const MAX_COMMIT_CHANGES = 50;
/** The maximum character length of a commit message. */
export const MAX_COMMIT_MESSAGE = 500;
/** The maximum character length of one text file's content. */
export const MAX_FILE_CONTENT = 1_000_000;
/** The maximum character length of one repository path. */
export const MAX_FILE_PATH = 512;

/** One proposed change to the bound repository. `content` is UTF-8 text only in V1. */
export interface CommitChange {
  path: string;
  operation: "add" | "update" | "delete";
  content?: string;
}

/** One NDJSON protocol record, exactly as the official client emits it. */
export type NdjsonRecord =
  | { key: "header"; value: { summary: string; description: string; parentCommit?: string } }
  | { key: "file"; value: { path: string; content: string; encoding: "utf-8"; size: number } }
  | { key: "deletedFile"; value: { path: string } };

/** Per-file content hashes bound to the approval and echoed into the receipt. */
export interface CommitFileHash {
  path: string;
  /** SHA-256 (hex) of the UTF-8 content; null for deletions. */
  sha256: string | null;
}

/** The validated, normalized commit: everything execution needs, nothing arbitrary. */
export interface ValidatedCommit {
  summary: string;
  description: string;
  revision: string;
  parentCommit?: string;
  /** Add/update files in proposal order. */
  files: { path: string; content: string }[];
  /** Delete paths in proposal order; the protocol emits them after all file records. */
  deletions: string[];
  records: NdjsonRecord[];
  hashes: CommitFileHash[];
}

const encoder = new TextEncoder();

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Revision guard shared by commit writes and read paths: a branch/tag name or commit SHA.
 * Rejects empty values, anything beyond the documented shape, and traversal segments — a
 * revision is interpolated into a URL path, so `..` is scope escape, not a name.
 */
export function validateRevision(revision: string | undefined, fallback = "main"): string {
  const rev = (revision ?? fallback).trim();
  if (!rev || rev.includes("..") || rev.startsWith("/") || !/^[A-Za-z0-9._/-]{1,128}$/.test(rev)) {
    throw new Error("Invalid revision.");
  }
  return rev;
}

function validatePath(raw: string): string {
  const path = typeof raw === "string" ? raw : "";
  if (!path || path.includes("..") || path.startsWith("/") || path.includes("\0") || path.length > MAX_FILE_PATH) {
    throw new Error("Invalid commit path.");
  }
  return path;
}

function validateTextContent(raw: string, path: string): string {
  if (typeof raw !== "string") throw new Error(`Commit file ${path} requires UTF-8 text content.`);
  // V1 is text-only: binary payloads must not be approximated as text. A string containing
  // lone surrogates cannot round-trip UTF-8 (TextEncoder would silently replace them, writing
  // content that differs from what was approved), so it is rejected here.
  if (!raw.isWellFormed()) throw new Error(`Commit file ${path} is not valid UTF-8 text; binary payloads are not supported.`);
  if (raw.length > MAX_FILE_CONTENT) throw new Error(`Commit file ${path} exceeds the ${MAX_FILE_CONTENT}-character limit.`);
  return raw;
}

/**
 * Validates and normalizes a commit against the V1 write surface, computing the per-file
 * content hashes that bind approval. Used by the session at proposal time and re-run by the
 * executor against the stored payload — the durable record, not session arguments, is what
 * the executor trusts.
 */
export async function validateCommit(input: {
  message: string;
  changes: CommitChange[];
  revision?: string;
  parentCommit?: string;
}): Promise<ValidatedCommit> {
  const message = typeof input.message === "string" ? input.message : "";
  if (!message.trim()) throw new Error("A commit requires a message.");
  if (message.length > MAX_COMMIT_MESSAGE) throw new Error(`A commit message exceeds the ${MAX_COMMIT_MESSAGE}-character limit.`);
  if (!Array.isArray(input.changes) || input.changes.length < 1 || input.changes.length > MAX_COMMIT_CHANGES) {
    throw new Error(`A commit requires 1–${MAX_COMMIT_CHANGES} changes.`);
  }
  const revision = validateRevision(input.revision);
  let parentCommit: string | undefined;
  if (input.parentCommit !== undefined) {
    if (typeof input.parentCommit !== "string" || !/^[0-9a-f]{7,64}$/i.test(input.parentCommit)) {
      throw new Error("Invalid parent commit; provide the commit SHA the change builds on.");
    }
    parentCommit = input.parentCommit;
  }

  const files: { path: string; content: string }[] = [];
  const deletions: string[] = [];
  for (const change of input.changes) {
    const path = validatePath(change?.path ?? "");
    if (change.operation === "delete") {
      if (change.content !== undefined) throw new Error(`Commit file ${path}: deletions do not carry content.`);
      deletions.push(path);
      continue;
    }
    if (change.operation !== "add" && change.operation !== "update") {
      throw new Error(`Commit file ${path} has an unsupported operation.`);
    }
    // Missing content is never silently reinterpreted as an empty file: an add/update must
    // carry the exact text that was approved.
    if (change.content === undefined) throw new Error(`Commit file ${path} requires UTF-8 text content.`);
    files.push({ path, content: validateTextContent(change.content, path) });
  }

  const hashes: CommitFileHash[] = [];
  for (const file of files) hashes.push({ path: file.path, sha256: await sha256Hex(file.content) });
  for (const path of deletions) hashes.push({ path, sha256: null });

  // Header summary is the first line, bounded; the Hub renders it as the commit title.
  const summary = message.slice(0, 200);
  const records: NdjsonRecord[] = [
    { key: "header", value: parentCommit === undefined ? { summary, description: message } : { summary, description: message, parentCommit } },
    ...files.map((file): NdjsonRecord => ({
      key: "file",
      value: { path: file.path, content: file.content, encoding: "utf-8", size: encoder.encode(file.content).byteLength },
    })),
    ...deletions.map((path): NdjsonRecord => ({ key: "deletedFile", value: { path } })),
  ];
  return { summary, description: message, revision, parentCommit, files, deletions, records, hashes };
}

/**
 * Serializes validated records into the exact wire body: one JSON record per line,
 * newline-terminated. The fixture asserts this string byte-for-byte.
 */
export function buildCommitNdjson(records: NdjsonRecord[]): string {
  return records.map((record) => JSON.stringify(record)).join("\n") + "\n";
}

/**
 * Extracts the commit OID from the endpoint response. The OID is the receipt's vendor
 * identifier; a response without a well-formed OID cannot verify the write and the caller
 * must treat the outcome as unknown.
 */
export function extractCommitOid(response: unknown): string {
  const oid = typeof response === "object" && response !== null ? (response as { commitOid?: unknown }).commitOid : undefined;
  if (typeof oid !== "string" || !/^[0-9a-f]{7,64}$/i.test(oid)) {
    throw new Error("Hugging Face commit response carried no commit OID; the write cannot be verified.");
  }
  return oid;
}

/**
 * The bounded reconciliation probe for an uncertain commit: compare the revision's HEAD commit
 * against the expected parent and the summary we submitted. With a bound parent, HEAD equal to
 * the parent proves the write is absent; a HEAD title equal to our summary is evidence it
 * landed. Everything else stays unknown — never a blind retry.
 */
export async function probeCommit(
  request: (url: string) => Promise<unknown>,
  baseUrl: string,
  commit: { revision: string; summary: string; parentCommit?: string },
): Promise<"applied" | "absent" | "unknown"> {
  try {
    const commits = await request(`${baseUrl}/commits/${encodeURIComponent(commit.revision)}`);
    const head = Array.isArray(commits) ? commits[0] : undefined;
    const id = typeof (head as { id?: unknown } | undefined)?.id === "string" ? (head as { id: string }).id : undefined;
    const title = typeof (head as { title?: unknown } | undefined)?.title === "string" ? (head as { title: string }).title : undefined;
    if (id === undefined) return "unknown";
    if (commit.parentCommit !== undefined && id === commit.parentCommit) return "absent";
    if (title === commit.summary) return "applied";
    return "unknown";
  } catch {
    return "unknown";
  }
}
