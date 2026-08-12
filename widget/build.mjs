import { build } from "esbuild";

await build({
  entryPoints: ["widget/src/index.ts"],
  bundle: true,
  format: "iife",
  target: "es2020",
  outfile: "widget-dist/widget.js",
  minify: process.env.NODE_ENV === "production",
});

console.log("Built widget-dist/widget.js");
