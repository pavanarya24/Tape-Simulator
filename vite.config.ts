import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Freebuff managed preview: the platform injects PORT and requires the dev
// server to bind to 0.0.0.0. HMR settings are left at Vite defaults and must
// not be overridden here.
export default defineConfig({
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    port: Number(process.env.PORT ?? 5173),
    hmr: false,
    // The managed preview proxies the dev server through a rotating sandbox
    // hostname, so the Host header can't be enumerated ahead of time.
    // Allow all hosts; this is a non-public, sandboxed dev server.
    allowedHosts: true,
  },
  preview: {
    host: "0.0.0.0",
    port: Number(process.env.PORT ?? 5173),
    allowedHosts: true,
  },
  build: {
    outDir: "dist",
    sourcemap: false,
  },
});
