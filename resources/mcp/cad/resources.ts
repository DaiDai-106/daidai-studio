import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Value } from "typebox/value";
import { type CadDisplay, CadManifestSchema, type CadResource } from "./contract.ts";

// Only native-produced resources under this service's private output root can be read.
export function createResources(root: string, budget: number, maxEntries: number) {
  const entries = new Map<string, CadResource>();
  let bytes = 0;
  async function file(resource: CadResource) {
    const path = fileURLToPath(resource.uri);
    const local = relative(root, await realpath(path));
    if (isAbsolute(local) || local === ".." || local.startsWith(`..${sep}`))
      throw new Error("CAD resource is outside its output root.");
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size !== resource.byteLength)
      throw new Error("CAD resource descriptor does not match its file.");
    return path;
  }
  return {
    async register(display: CadDisplay) {
      if (entries.has(display.manifest.uri)) return;
      if (display.manifest.byteLength > 32 * 1024 * 1024)
        throw new Error("CAD manifest exceeds its metadata budget.");
      const manifestBytes = await readFile(await file(display.manifest));
      if (createHash("sha256").update(manifestBytes).digest("hex") !== display.manifest.sha256)
        throw new Error("CAD manifest hash mismatch.");
      const manifest: unknown = JSON.parse(manifestBytes.toString("utf8"));
      if (!Value.Check(CadManifestSchema, manifest)) throw new Error("Invalid CAD manifest.");
      const resources = [...manifest.resources, display.manifest];
      const fresh = resources.filter((resource) => !entries.has(resource.uri));
      if (entries.size + fresh.length > maxEntries)
        throw new Error("CAD retained resource count exceeds its budget.");
      if (bytes + fresh.reduce((sum, resource) => sum + resource.byteLength, 0) > budget)
        throw new Error("CAD retained resources exceed their budget.");
      for (const resource of fresh) await file(resource);
      for (const resource of fresh) {
        entries.set(resource.uri, resource);
        bytes += resource.byteLength;
      }
    },
    list(cursor?: string) {
      const offset = cursor === undefined ? 0 : Number(cursor);
      if (
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        offset > entries.size ||
        (cursor !== undefined && String(offset) !== cursor)
      )
        throw new Error("Invalid CAD resource cursor.");
      const page = [...entries.values()].slice(offset, offset + 50);
      return {
        resources: page.map(({ uri, mediaType }) => ({
          uri,
          name: uri.split("/").at(-1) ?? "resource",
          mimeType: mediaType,
        })),
        ...(offset + page.length < entries.size
          ? { nextCursor: String(offset + page.length) }
          : {}),
      };
    },
    async read(uri: string) {
      const resource = entries.get(uri);
      if (!resource) throw new Error("Unknown CAD resource.");
      if (resource.byteLength > 1024 * 1024)
        throw new Error(
          "Resource exceeds resources/read limit; local hosts must stream the registered file URI.",
        );
      const content = await readFile(await file(resource));
      if (createHash("sha256").update(content).digest("hex") !== resource.sha256)
        throw new Error("CAD resource hash mismatch.");
      return {
        contents: [
          resource.mediaType === "application/json"
            ? { uri, mimeType: resource.mediaType, text: content.toString("utf8") }
            : { uri, mimeType: resource.mediaType, blob: content.toString("base64") },
        ],
      };
    },
  };
}
