import { execFileSync } from "node:child_process";
import { globSync, readFileSync } from "node:fs";
import packageInfo from "../package.json" with { type: "json" };
import { getReleaseNotes } from "../src/shared/changelog.ts";

const { version } = packageInfo;
const { GITHUB_REF_NAME: tag, GITHUB_REPOSITORY: repository } = process.env;
if (!repository) throw new Error("Missing GITHUB_REPOSITORY.");
if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version) || tag !== `v${version}`) {
  throw new Error(`Release tag must match the stable package version v${version}.`);
}

const notes = getReleaseNotes(readFileSync("CHANGELOG.md", "utf8"), version);
if (!notes) throw new Error(`Missing release notes for ${version} in CHANGELOG.md.`);

const installers = ["deb", "dmg", "exe"].map((extension) => {
  const matching = globSync(`installers/*.${extension}`);
  const [installer] = matching;
  if (!installer || matching.length !== 1) {
    throw new Error(`Expected one .${extension} installer, found ${matching.length}.`);
  }
  return installer;
});

execFileSync(
  "gh",
  [
    "release",
    "create",
    tag,
    ...installers,
    "--repo",
    repository,
    "--verify-tag",
    "--title",
    `Dai Studio ${tag}`,
    "--notes-file",
    "-",
  ],
  { input: `${notes}\n`, stdio: ["pipe", "inherit", "inherit"] },
);
