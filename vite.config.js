import { defineConfig } from "vite";

export default defineConfig({
  // Relative assets work for both user.github.io and project Pages URLs.
  base: "./",
  build: {
    target: "es2022",
    sourcemap: true,
  },
});
