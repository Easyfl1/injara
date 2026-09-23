import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const pkgPath = resolve(process.cwd(), "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));

const sdkVersion = pkg.dependencies?.["@injectivelabs/sdk-ts"];
if (!sdkVersion) {
  console.log("No @injectivelabs/sdk-ts dependency found, skipping check");
  process.exit(0);
}

if (sdkVersion === "1.20.21") {
  console.error("DENIED: @injectivelabs/sdk-ts version 1.20.21 is banned (supply-chain risk)");
  process.exit(1);
}

const match = sdkVersion.match(/^[\^~]?(\d+)\.(\d+)\.(\d+)/);
if (match) {
  const [, major, minor, patch] = match.map(Number);
  if (major === 1 && minor === 20 && patch < 23) {
    console.error(
      `DENIED: @injectivelabs/sdk-ts version ${sdkVersion} < 1.20.23 is banned`,
    );
    process.exit(1);
  }
}

console.log(`OK: @injectivelabs/sdk-ts ${sdkVersion}`);
