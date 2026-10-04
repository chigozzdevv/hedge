import { defineConfig } from "tsup";
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: { compilerOptions: { incremental: false, noEmit: false } },
  clean: true,
  external: ["react", "react-dom"],
  footer: { js: 'import "./index.css";' },
});
