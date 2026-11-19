export function getReleaseNotes(changelog: string, version: string): string | undefined {
  const section = changelog
    .split(/^## (?=\[)/m)
    .slice(1)
    .find((entry) => entry.startsWith(`[${version}]`));
  return section?.split("\n").slice(1).join("\n").trim() || undefined;
}
