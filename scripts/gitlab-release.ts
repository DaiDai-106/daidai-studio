import { execFileSync } from "node:child_process";
import { openAsBlob } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { getReleaseNotes } from "../src/shared/changelog.ts";

const stableTag = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const firstTag = "v0.0.1";
const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8" }).trim();

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function projectApi() {
  return `${required("CI_API_V4_URL").replace(/\/$/, "")}/projects/${encodeURIComponent(required("CI_PROJECT_ID"))}`;
}

function registry(version: string) {
  return `${projectApi()}/packages/generic/dai-studio-release/${version}`;
}

function artifactName(version: string) {
  return `dai-studio_${version}_amd64.deb`;
}

function api(url: string, init: RequestInit = {}) {
  return fetch(url, {
    redirect: "error",
    signal: AbortSignal.timeout(10 * 60_000),
    ...init,
    headers: { "JOB-TOKEN": required("CI_JOB_TOKEN"), ...init.headers },
  });
}

async function checked(response: Response, action: string) {
  if (!response.ok) throw new Error(`${action} failed (HTTP ${response.status})`);
  return response;
}

type Release = {
  commit: { id: string };
  assets: { links: { name: string; url: string }[] };
};

function verifyPackageAsset(release: Release, tag: string) {
  const name = artifactName(tag.slice(1));
  const url = release.assets?.links?.find((link) => link.name === name)?.url;
  const prefix = registry("");
  const [storageVersion, filename, extra] = url?.startsWith(prefix)
    ? url.slice(prefix.length).split("/")
    : [];
  if (
    !storageVersion ||
    !/^0\.0\.\d+$/.test(storageVersion) ||
    filename !== name ||
    extra !== undefined
  ) {
    throw new Error(`Release ${tag} has no matching package registry asset`);
  }
}

async function readRelease(tag: string): Promise<Release | undefined> {
  const response = await api(`${projectApi()}/releases/${tag}`);
  if (response.status === 404) return undefined;
  return (await (await checked(response, `Read release ${tag}`)).json()) as Release;
}

type Plan = { version: string; tag: string; commit: string; notes: string; published: boolean };

async function prepare(): Promise<Plan> {
  const commit = required("CI_COMMIT_SHA");
  if (git("rev-parse", "HEAD") !== commit) throw new Error("Checkout does not match CI_COMMIT_SHA");
  // A new release line starts at v0.0.1 even if the repository has legacy tags.
  const tags = git("tag", "--list", firstTag)
    ? git("tag", "--contains", firstTag, "--sort=-version:refname")
        .split("\n")
        .filter((tag) => stableTag.test(tag))
    : [];
  const latest = tags[0];
  const existing = git("tag", "--points-at", commit)
    .split("\n")
    .filter((tag) => tags.includes(tag));
  if (existing.length > 1) throw new Error("Commit has more than one stable release tag");

  const existingTag = existing[0];
  if (existingTag) {
    const release = await readRelease(existingTag);
    if (release) {
      if (release.commit.id !== commit)
        throw new Error(`Release ${existingTag} points to another commit`);
      verifyPackageAsset(release, existingTag);
      return {
        version: existingTag.slice(1),
        tag: existingTag,
        commit,
        notes: "",
        published: true,
      };
    }
    if (existingTag !== latest) throw new Error(`Cannot publish superseded tag ${existingTag}`);
  }

  // A pipeline for an older commit may reach the job after a newer one already published.
  if (latest) {
    try {
      git("merge-base", "--is-ancestor", latest, commit);
    } catch {
      throw new Error(`Release commit must descend from ${latest}`);
    }
  }

  const [, major, minor, patch] = stableTag.exec(latest ?? "") ?? [];
  const version =
    existingTag?.slice(1) ??
    (patch ? `${major}.${minor}.${BigInt(patch) + 1n}` : firstTag.slice(1));
  const changelog = await readFile("CHANGELOG.md", "utf8");
  const notes = getReleaseNotes(changelog, version);
  if (!notes) throw new Error(`Add non-empty release notes under ## [${version}] in CHANGELOG.md`);
  return { version, tag: `v${version}`, commit, notes, published: false };
}

async function publish(planPath: string, deb: string) {
  const plan = JSON.parse(await readFile(planPath, "utf8")) as Plan;
  const name = artifactName(plan.version);
  if (basename(deb) !== name || plan.published || plan.commit !== required("CI_COMMIT_SHA")) {
    throw new Error("Release plan does not match the built artifact");
  }
  const uploadId = required("CI_JOB_ID");
  if (!/^\d+$/.test(uploadId)) throw new Error("Invalid CI_JOB_ID");
  // Job-specific storage prevents a retry or an interrupted upload from replacing another binary.
  const url = `${registry(`0.0.${uploadId}`)}/${name}`;
  await checked(
    await api(url, {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream" },
      body: await openAsBlob(deb),
    }),
    "Upload .deb",
  );
  await checked(
    await api(`${projectApi()}/releases`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: `Dai Studio ${plan.tag}`,
        tag_name: plan.tag,
        ref: plan.commit,
        description: plan.notes,
        assets: { links: [{ name, url, link_type: "package", direct_asset_path: `/${name}` }] },
      }),
    }),
    `Create release ${plan.tag}`,
  );
  console.log(`Published ${plan.tag} with ${name}`);
}

const [action, first, second] = process.argv.slice(2);
if (action === "prepare") console.log(JSON.stringify(await prepare()));
else if (action === "publish" && first && second) await publish(first, second);
else throw new Error("Usage: gitlab-release.ts prepare | publish PLAN DEB");
