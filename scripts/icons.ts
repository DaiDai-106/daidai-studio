import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Resvg } from "@resvg/resvg-js";
import { BICUBIC2, createICNS, createICO } from "png2icons";

const root = join(import.meta.dirname, "..");
const source = await readFile(join(root, "resources/icons/app.svg"));
const destination = join(root, "dist/icons");
await mkdir(destination, { recursive: true });

for (const size of [16, 24, 32, 48, 64, 128, 256, 512, 1024]) {
  const image = new Resvg(source, {
    fitTo: { mode: "width", value: size },
    font: { loadSystemFonts: false },
  }).render();
  await writeFile(join(destination, `${size}.png`), image.asPng());
}

const master = await readFile(join(destination, "1024.png"));
const icns = createICNS(master, BICUBIC2, 0);
const ico = createICO(master, BICUBIC2, 0, true, true);
if (!icns || !ico) throw new Error("Could not convert the Dai icon to ICNS and ICO.");
await writeFile(join(destination, "app.icns"), icns);
await writeFile(join(destination, "app.ico"), ico);

const template = await readFile(join(root, "resources/icons/tray.svg"));
for (const scale of [1, 2]) {
  const image = new Resvg(template, {
    dpi: 72 * scale,
    fitTo: { mode: "width", value: 16 * scale },
    font: { loadSystemFonts: false },
  }).render();
  const filename = scale === 1 ? "trayTemplate.png" : "trayTemplate@2x.png";
  await writeFile(join(destination, filename), image.asPng());
}
