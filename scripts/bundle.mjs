// The <script> build: one IIFE file that defines the global `GaiaDeskEmbed`
// (`GaiaDeskEmbed.start({...})`), plain and minified, from the same source
// as the ESM build (tsc writes dist/*.js and the .d.ts files).
import { build } from "esbuild";

const common = {
  entryPoints: ["src/index.ts"],
  bundle: true,
  format: "iife",
  globalName: "GaiaDeskEmbed",
  target: ["es2020"],
  platform: "browser",
  legalComments: "none",
  banner: { js: "/*! @gaiadesk/embed | MIT License | https://github.com/Gaia-Desk/gaiadesk-embed */" },
};

await build({ ...common, outfile: "dist/gaiadesk-embed.js" });
await build({ ...common, outfile: "dist/gaiadesk-embed.min.js", minify: true });
console.log("wrote dist/gaiadesk-embed.js and dist/gaiadesk-embed.min.js");
