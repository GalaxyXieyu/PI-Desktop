import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, mkdir, open, realpath, rm, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import type { AgentPromptAttachment } from "@pi-desktop/shared";

export const REMOTE_ATTACHMENT_BYTES = 4 * 1024 * 1024;
export const REMOTE_ATTACHMENT_TTL = 30 * 60 * 1000;
export function remoteSessionFolder(sessionId: string): string { return createHash("sha256").update(sessionId).digest("hex"); }
export type RemoteAttachment = { attachmentId: string; name: string; mediaType: string; size: number; kind: "image" | "file" };
type Entry = RemoteAttachment & { sessionId: string; path: string; directory: string; expires: number; pins: number; hash: string };
export class RemoteAttachmentError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status = 400) { super(code); this.code = code; this.status = status; }
}
function fail(code: string, status = 400): never { throw new RemoteAttachmentError(code, status); }
const textExtensions = new Set("txt md markdown json csv log ts tsx js jsx mjs cjs py yaml yml toml xml html css sql sh rs go java c h cpp hpp rb ini conf".split(" "));
const textTypes = new Set(["text/plain", "text/markdown", "text/csv", "text/javascript", "text/typescript", "text/x-python", "application/json", "application/javascript", "application/typescript", "application/yaml", "text/yaml", "application/xml", "text/xml", "text/html", "text/css"]);
const imageExtensions: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp" };
function validate(name: string, mediaType: string, bytes: Buffer): "image" | "file" {
  if (!name || name.length > 200 || name !== name.trim() || /[\\/\u0000-\u001f\u007f-\u009f]/.test(name) || name.includes("..") || /^[.]/.test(name) || /[:]/.test(name)) fail("INVALID_ATTACHMENT_NAME");
  if (!bytes.length || bytes.length > REMOTE_ATTACHMENT_BYTES) fail("ATTACHMENT_TOO_LARGE");
  const extension = extname(name).slice(1).toLowerCase();
  if (imageExtensions[extension]) {
    if (mediaType !== imageExtensions[extension]) fail("UNSUPPORTED_ATTACHMENT_TYPE");
    const png = bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && bytes.toString("ascii", 12, 16) === "IHDR";
    const jpeg = bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 && bytes.at(-2) === 255 && bytes.at(-1) === 217;
    const webp = bytes.length >= 20 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP" && ["VP8 ", "VP8L", "VP8X"].includes(bytes.toString("ascii", 12, 16)) && bytes.readUInt32LE(4) + 8 === bytes.length;
    if (!(mediaType === "image/png" ? png : mediaType === "image/jpeg" ? jpeg : webp)) fail("INVALID_ATTACHMENT_DATA");
    return "image";
  }
  if (!textExtensions.has(extension) || !textTypes.has(mediaType)) fail("UNSUPPORTED_ATTACHMENT_TYPE");
  try { const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); if (text.includes("\0")) fail("INVALID_ATTACHMENT_DATA"); } catch { fail("INVALID_ATTACHMENT_DATA"); }
  return "file";
}

/** Opaque, session-owned, bounded upload staging. Paths never cross the REST wire. */
export class RemoteAttachments {
  private readonly entries = new Map<string, Entry>();
  private readonly epoch = randomUUID();
  private bytes = 0;
  private closed = false;
  private timer?: ReturnType<typeof setInterval>;
  private readonly writes = new Set<Promise<unknown>>();
  private readonly dataDir: string;
  private readonly now: () => number;
  private readonly log: (error: unknown) => void;
  constructor(dataDir: string, now: () => number = Date.now, log: (error: unknown) => void = () => {}) { this.dataDir = dataDir; this.now = now; this.log = log; }
  start() { this.timer = setInterval(() => { void this.cleanup().catch(this.log); }, 60_000); this.timer.unref(); }
  upload(sessionId: string, body: Record<string, unknown>): Promise<RemoteAttachment> {
    const operation = this.store(sessionId, body);
    this.writes.add(operation);
    void operation.finally(() => this.writes.delete(operation)).catch(() => {});
    return operation;
  }
  private async store(sessionId: string, body: Record<string, unknown>): Promise<RemoteAttachment> {
    if (this.closed) fail("SHUTTING_DOWN", 502);
    if (typeof body.name !== "string" || typeof body.mediaType !== "string" || typeof body.data !== "string") fail("INVALID_ARGUMENT");
    if (body.data.length > Math.ceil(REMOTE_ATTACHMENT_BYTES / 3) * 4) fail("ATTACHMENT_TOO_LARGE");
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(body.data)) fail("INVALID_ATTACHMENT_DATA");
    const bytes = Buffer.from(body.data, "base64");
    if (bytes.toString("base64") !== body.data) fail("INVALID_ATTACHMENT_DATA");
    const kind = validate(body.name, body.mediaType, bytes);
    if (this.entries.size >= 256 || this.bytes + bytes.length > 64 * 1024 * 1024) fail("ATTACHMENT_LIMIT", 409);
    const owned = [...this.entries.values()].filter(entry => entry.sessionId === sessionId);
    if (owned.length >= 32 || owned.reduce((sum, entry) => sum + entry.size, 0) + bytes.length > 32 * 1024 * 1024) fail("ATTACHMENT_LIMIT", 409);
    const attachmentId = randomUUID();
    const directory = join(resolve(this.dataDir), "remote-attachments", remoteSessionFolder(sessionId), this.epoch, attachmentId);
    const path = join(directory, "payload");
    const entry: Entry = { attachmentId, sessionId, name: body.name, mediaType: body.mediaType, size: bytes.length, kind, path, directory, expires: this.now() + REMOTE_ATTACHMENT_TTL, pins: 1, hash: createHash("sha256").update(bytes).digest("hex") };
    // Reserve quotas before IO so concurrent uploads cannot overrun them.
    this.entries.set(attachmentId, entry); this.bytes += entry.size;
    try {
      const components = [join(resolve(this.dataDir), "remote-attachments"), join(resolve(this.dataDir), "remote-attachments", remoteSessionFolder(sessionId)), join(resolve(this.dataDir), "remote-attachments", remoteSessionFolder(sessionId), this.epoch), directory];
      for (const component of components) {
        await mkdir(component, { recursive: true, mode: 0o700 });
        if (await realpath(component) !== component) fail("INVALID_ATTACHMENT_DATA");
        await chmod(component, 0o700);
      }
      await writeFile(path, bytes, { mode: 0o600, flag: "wx" });
      entry.pins = 0;
      return { attachmentId, name: entry.name, mediaType: entry.mediaType, size: entry.size, kind };
    } catch (error) { await this.remove(entry); throw error; }
  }
  async acquire(sessionId: string, ids: unknown, supportsVision: boolean): Promise<{ attachments: AgentPromptAttachment[]; release: (accepted: boolean) => Promise<void> }> {
    if (!Array.isArray(ids) || ids.length > 4 || ids.some(id => typeof id !== "string") || new Set(ids).size !== ids.length) fail("INVALID_ATTACHMENT_IDS");
    const entries = ids.map(id => {
      const entry = this.entries.get(id);
      if (!entry || entry.sessionId !== sessionId) fail("ATTACHMENT_NOT_FOUND", 409);
      if (entry.expires <= this.now()) fail("ATTACHMENT_EXPIRED", 409);
      if (entry.kind === "image" && !supportsVision) fail("MODEL_VISION_UNSUPPORTED", 409);
      return entry;
    });
    if (entries.reduce((sum, entry) => sum + entry.size, 0) > 16 * 1024 * 1024) fail("ATTACHMENT_TOO_LARGE");
    for (const entry of entries) entry.pins++;
    const release = async (accepted: boolean) => {
      for (const entry of entries) { entry.pins--; if (accepted || (entry.expires <= this.now() && !entry.pins)) await this.remove(entry); }
    };
    try {
      for (const entry of entries) {
        if (await realpath(entry.path) !== entry.path) fail("INVALID_ATTACHMENT_DATA");
        const file = await open(entry.path, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const stat = await file.stat();
          if (!stat.isFile() || stat.size !== entry.size || stat.size > REMOTE_ATTACHMENT_BYTES || (stat.mode & 0o077)) fail("INVALID_ATTACHMENT_DATA");
          const bytes = await file.readFile();
          if (createHash("sha256").update(bytes).digest("hex") !== entry.hash) fail("INVALID_ATTACHMENT_DATA");
          validate(entry.name, entry.mediaType, bytes);
        } finally { await file.close(); }
      }
      return { attachments: entries.map(entry => ({ path: entry.path, name: entry.name, mimeType: entry.mediaType, size: entry.size, kind: entry.kind })), release };
    } catch (error) { await release(false); if (error instanceof RemoteAttachmentError) throw error; fail("ATTACHMENT_NOT_FOUND", 409); }
  }
  private async remove(entry: Entry) {
    if (!this.entries.delete(entry.attachmentId)) return;
    this.bytes -= entry.size;
    await rm(entry.directory, { recursive: true, force: true });
  }
  async cleanup() { for (const entry of this.entries.values()) if (!entry.pins && entry.expires <= this.now()) await this.remove(entry); }
  async stop() {
    this.closed = true; if (this.timer) clearInterval(this.timer);
    await Promise.allSettled(this.writes);
    for (const entry of this.entries.values()) await this.remove(entry);
  }
}
