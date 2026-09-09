import { reactRouter } from "@react-router/dev/vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    // Runs the dev server inside workerd, so local development uses the same
    // runtime as production rather than Node with a different set of globals.
    cloudflare({ viteEnvironment: { name: "ssr" } }),
    tailwindcss(),
    reactRouter(),
  ],
  resolve: { tsconfigPaths: true },
  build: {
    // Named chunks so the animation libraries stay out of the dashboard bundle.
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("gsap") || id.includes("lenis")) return "motion";
        },
      },
    },
  },
  server: { port: 5173 },
});
