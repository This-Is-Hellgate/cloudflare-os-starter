// Task 1.2 focused verification: the official Hub commit protocol through the REAL serializer.
// Unicode content, deletion, parent-commit binding, and OID extraction; plus the denial case for
// payloads outside the V1 text-only surface. The module under test is the same one the Gatekeeper
// session and executor call.
import { describe, expect, it } from "vitest";
import {
  NDJSON_CONTENT_TYPE,
  buildCommitNdjson,
  extractCommitOid,
  probeCommit,
  validateCommit,
  validateRevision,
} from "../src/ndjson.js";

// Well-known SHA-256 vector pinning the digest used for approval-bound content hashes.
const SHA256_HELLO = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";

describe("Hub commit NDJSON protocol", () => {
  it("serializes an official-protocol commit: header, unicode text files, deletion, parent commit", async () => {
    const parent = "1234567890abcdef1234567890abcdef12345678";
    const commit = await validateCommit({
      message: "Update docs — héllo 🎉",
      changes: [
        { path: "notes/héllo.md", operation: "add", content: "hello" },
        { path: "README.md", operation: "update", content: "naïve ✓" },
        { path: "old/legacy.txt", operation: "delete" },
      ],
      revision: "main",
      parentCommit: parent,
    });

    expect(NDJSON_CONTENT_TYPE).toBe("application/x-ndjson");
    const body = buildCommitNdjson(commit.records);
    const lines = body.split("\n");
    // Newline-terminated, one record per line: header + 2 files + 1 deletion = 4 records.
    expect(lines).toHaveLength(5);
    expect(lines[4]).toBe("");

    const header = JSON.parse(lines[0]) as { key: string; value: Record<string, unknown> };
    expect(header).toEqual({
      key: "header",
      value: { summary: "Update docs — héllo 🎉", description: "Update docs — héllo 🎉", parentCommit: parent },
    });

    // Text files ride as utf-8 records with the exact UTF-8 byte length the Hub validates.
    const first = JSON.parse(lines[1]) as { key: string; value: { path: string; content: string; encoding: string; size: number } };
    expect(first).toEqual({ key: "file", value: { path: "notes/héllo.md", content: "hello", encoding: "utf-8", size: 5 } });
    const second = JSON.parse(lines[2]) as typeof first;
    expect(second.value.encoding).toBe("utf-8");
    expect(second.value.size).toBe(new TextEncoder().encode("naïve ✓").byteLength);
    expect(second.value.content).toBe("naïve ✓");

    // Deletions come last, as path-only records with no content field.
    const deletion = JSON.parse(lines[3]) as { key: string; value: Record<string, unknown> };
    expect(deletion).toEqual({ key: "deletedFile", value: { path: "old/legacy.txt" } });

    // Content hashes bound to approval: sha256 of the UTF-8 content, null for deletions.
    expect(commit.hashes).toEqual([
      { path: "notes/héllo.md", sha256: SHA256_HELLO },
      { path: "README.md", sha256: expect.any(String) },
      { path: "old/legacy.txt", sha256: null },
    ]);
  });

  it("defaults the revision to main and omits parentCommit when not supplied", async () => {
    const commit = await validateCommit({ message: "solo", changes: [{ path: "a.txt", operation: "add", content: "x" }] });
    expect(commit.revision).toBe("main");
    expect(commit.parentCommit).toBeUndefined();
    const header = JSON.parse(buildCommitNdjson(commit.records).split("\n")[0]) as { value: Record<string, unknown> };
    expect("parentCommit" in header.value).toBe(false);
  });

  it("extracts the returned commit OID and refuses responses without one", () => {
    expect(extractCommitOid({ commitOid: "abcdef1234567890abcdef1234567890abcdef12" })).toBe("abcdef1234567890abcdef1234567890abcdef12");
    expect(() => extractCommitOid({})).toThrow(/no commit OID/);
    expect(() => extractCommitOid({ commitOid: 42 })).toThrow(/no commit OID/);
    expect(() => extractCommitOid("abcdef")).toThrow(/no commit OID/);
    expect(() => extractCommitOid(undefined)).toThrow(/no commit OID/);
  });

  it("reconciles an uncertain commit from parent/expected metadata", async () => {
    const parent = "1234567890abcdef1234567890abcdef12345678";
    const head = (id: string, title: string) => async () => [{ id, title }];
    const ours = { revision: "main", summary: "Update docs", parentCommit: parent };

    // HEAD is still the parent: the write is provably absent.
    expect(await probeCommit(head(parent, "old work"), "base", ours)).toBe("absent");
    // HEAD title matches what we submitted: evidence the commit landed.
    expect(await probeCommit(head("ffffff", "Update docs"), "base", ours)).toBe("applied");
    // Anything else — including a transport error — stays unknown; never a blind retry.
    expect(await probeCommit(head("ffffff", "someone else"), "base", ours)).toBe("unknown");
    expect(await probeCommit(async () => { throw new Error("timeout"); }, "base", ours)).toBe("unknown");
    // Without a bound parent, absence cannot be proven: unknown.
    expect(await probeCommit(head("ffffff", "unrelated"), "base", { revision: "main", summary: "Update docs" })).toBe("unknown");
  });
});

describe("V1 write-surface denials", () => {
  const base = { message: "m", changes: [{ path: "a.txt", operation: "add" as const, content: "x" }] };

  it("rejects empty and oversized change sets", async () => {
    await expect(validateCommit({ ...base, changes: [] })).rejects.toThrow(/1–50 changes/);
    await expect(validateCommit({ ...base, changes: Array.from({ length: 51 }, (_, i) => ({ path: `f${i}.txt`, operation: "add" as const, content: "x" })) })).rejects.toThrow(/1–50 changes/);
  });

  it("rejects path traversal, leading slashes, NULs, and empty paths", async () => {
    for (const path of ["../escape.txt", "/abs.txt", "a\0b", "sub/../x.txt", ""]) {
      await expect(validateCommit({ ...base, changes: [{ path, operation: "add", content: "x" }] })).rejects.toThrow(/Invalid commit path/);
    }
  });

  it("rejects deletions that carry content and adds without text", async () => {
    await expect(validateCommit({ ...base, changes: [{ path: "a.txt", operation: "delete", content: "x" }] })).rejects.toThrow(/do not carry content/);
    await expect(validateCommit({ ...base, changes: [{ path: "a.txt", operation: "add" }] })).rejects.toThrow(/requires UTF-8 text/);
  });

  it("rejects binary payloads: lone surrogates are not UTF-8 text", async () => {
    const binary = "bad \uD800 surrogate";
    await expect(validateCommit({ ...base, changes: [{ path: "a.bin", operation: "add", content: binary }] })).rejects.toThrow(/not valid UTF-8 text/);
  });

  it("rejects malformed revisions and parent commits", async () => {
    await expect(validateCommit({ ...base, revision: "../main" })).rejects.toThrow(/Invalid revision/);
    await expect(validateCommit({ ...base, revision: "" })).rejects.toThrow(/Invalid revision/);
    await expect(validateCommit({ ...base, parentCommit: "not-a-sha" })).rejects.toThrow(/Invalid parent commit/);
    await expect(validateCommit({ ...base, parentCommit: "zzzz" })).rejects.toThrow(/Invalid parent commit/);
  });

  it("rejects empty and oversized messages", async () => {
    await expect(validateCommit({ ...base, message: "   " })).rejects.toThrow(/requires a message/);
    await expect(validateCommit({ ...base, message: "m".repeat(501) })).rejects.toThrow(/500-character/);
  });

  it("keeps the read paths on the same revision guard", () => {
    expect(validateRevision(undefined)).toBe("main");
    expect(validateRevision("refs/pr/1")).toBe("refs/pr/1");
    expect(() => validateRevision("../main")).toThrow(/Invalid revision/);
    expect(() => validateRevision("")).toThrow(/Invalid revision/);
  });
});
