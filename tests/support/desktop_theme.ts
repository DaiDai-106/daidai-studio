import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { desktopThemeColors } from "../../src/contracts/desktop_theme.ts";

export const desktopThemeId = "test-desktop-theme:paper";

export async function createThemePackage(directory: string) {
  await mkdir(join(directory, "palettes"), { recursive: true });
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({
      name: "test-desktop-theme",
      version: "1.0.0",
      dai: {
        schemaVersion: 1,
        host: "daidai_pi",
        themes: [
          {
            id: "paper",
            label: "纸色主题",
            light: "palettes/light.json",
            dark: "palettes/dark.json",
          },
        ],
      },
    }),
  );
  for (const mode of ["light", "dark"] as const) {
    const variables = Object.fromEntries(desktopThemeColors.map((name) => [name, "#777777"]));
    Object.assign(variables, {
      "--surface": mode === "light" ? "#faf9f5" : "#262624",
      "--text": mode === "light" ? "#302f2b" : "#e9e6dc",
      "--theme-backdrop": "#00000055",
      "--shadow": "0 2px 10px #00000010",
      "--popup-shadow": "0 12px 36px #00000020",
    });
    await writeFile(
      join(directory, "palettes", `${mode}.json`),
      JSON.stringify({
        schemaVersion: 1,
        mode,
        variables,
      }),
    );
  }
}
