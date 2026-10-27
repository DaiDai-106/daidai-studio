import type { SkillImage } from "../../shared/capabilities.ts";
import type { Skill } from "../types.ts";

function imageReference(image: SkillImage) {
  return `[${image.name}的参考图](${image.path})`;
}

// Always derive attachment changes from the latest form state: image reads are asynchronous.
export function appendSkillImage(draft: Skill, image: SkillImage): Skill {
  if (draft.images?.some((item) => item.path === image.path)) return draft;
  return {
    ...draft,
    images: [...(draft.images ?? []), image],
    body: `${draft.body.trimEnd()}\n\n${imageReference(image)}`,
  };
}

export function removeSkillImage(draft: Skill, image: SkillImage): Skill {
  const images = (draft.images ?? []).filter((item) => item.path !== image.path);
  const { images: _images, ...withoutImages } = draft;
  return {
    ...withoutImages,
    ...(images.length ? { images } : {}),
    body: draft.body.replace(`\n\n${imageReference(image)}`, ""),
  };
}
