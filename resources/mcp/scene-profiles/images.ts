import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type ImageData = { mimeType: "image/png" | "image/jpeg" | "image/webp"; data: string };

function directory(root: string, skillId: string) {
  return join(root, createHash("sha256").update(skillId).digest("hex"));
}

function imagePath(root: string, skillId: string, path: string) {
  if (!/^images\/[0-9a-f-]{36}\.(png|jpg|webp)$/.test(path))
    throw new Error("无效的技能图片路径。");
  return join(directory(root, skillId), path);
}

function mimeType(path: string): ImageData["mimeType"] {
  return path.endsWith(".png") ? "image/png" : path.endsWith(".jpg") ? "image/jpeg" : "image/webp";
}

export async function addSkillImage(root: string, skillId: string, image: ImageData) {
  const bytes = Buffer.from(image.data, "base64");
  const valid =
    image.mimeType === "image/png"
      ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : image.mimeType === "image/jpeg"
        ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
        : bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP";
  if (!valid || bytes.length > 5 * 1024 * 1024) throw new Error("图片格式无效或超过 5 MB。");
  const extension = image.mimeType === "image/jpeg" ? "jpg" : image.mimeType.slice(6);
  const path = `images/${randomUUID()}.${extension}`;
  const target = imagePath(root, skillId, path);
  await mkdir(join(directory(root, skillId), "images"), { recursive: true });
  await writeFile(target, bytes);
  return path;
}

export async function readSkillImage(
  root: string,
  skillId: string,
  path: string,
): Promise<ImageData> {
  const data = await readFile(imagePath(root, skillId, path));
  if (data.length > 5 * 1024 * 1024) throw new Error("技能图片超过 5 MB。");
  return { mimeType: mimeType(path), data: data.toString("base64") };
}

export async function removeSkillImages(root: string, skillId: string, paths?: string[]) {
  if (!paths) return rm(directory(root, skillId), { recursive: true, force: true });
  await Promise.all(paths.map((path) => rm(imagePath(root, skillId, path), { force: true })));
}
