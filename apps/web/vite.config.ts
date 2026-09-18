import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnvFile } from "dotenv";
import { reactRouter } from "@react-router/dev/vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

/*
 * The same `.env` the route table reads (see app/routes.ts), so the constant
 * below is built from exactly the value the routes were mounted under.
 */
loadEnvFile({ path: resolve(dirname(fileURLToPath(import.meta.url)), "../../.env"), quiet: true });

/**
 * WHERE THE ROUTE TABLE PUT THE CONSOLE, baked into the bundle.
 *
 * The console's prefix has two independent sources and they are allowed to
 * disagree in silence. `routes.ts` reads `.env` at BUILD time to decide where
 * to mount the pages; the Worker reads its own environment at RUNTIME to
 * decide what links to render. Deployed, one secret feeds both. Locally they
 * are different files — `.env` and `.dev.vars` — and setting only the first
 * mounts the console at a secret path while every link inside it points at
 * `/admin`, which is the decoy that returns 404.
 *
 * That cost an afternoon: five console journeys failed with "heading not
 * found", on a console that was rendering perfectly at an address nothing
 * linked to. Publishing the build-time answer lets the runtime notice the
 * disagreement and say so.
 */
const ADMIN_PREFIX_AT_BUILD = process.env.ADMIN_PATH ?? "/admin";

export default defineConfig({
  define: {
    __ADMIN_PREFIX_AT_BUILD__: JSON.stringify(ADMIN_PREFIX_AT_BUILD),
  },
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
