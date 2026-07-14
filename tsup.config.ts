import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  // No source maps in the published package: they embed the full TS source
  // (sourcesContent) and needlessly bloat the tarball. The source is public on
  // GitHub for debugging. Re-enable with { sourcesContent: false } if consumer
  // stack-trace mapping is ever needed.
  sourcemap: false,
  clean: true,
  treeshake: true,
  outExtension({ format }) {
    return { js: format === "cjs" ? ".cjs" : ".js" };
  },
});
