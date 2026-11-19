import metadata from "../../package.json" with { type: "json" };

export const productName = metadata.productName;
export const packageName = metadata.name;
export const desktopName = metadata.desktopName;
