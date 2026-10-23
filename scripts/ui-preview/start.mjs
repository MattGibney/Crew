// Developer-only Vite presentation. No controller, profile, auth or native runtime.
import { createServer } from "vite";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../../", import.meta.url));
const port = Number(process.env.CREW_PREVIEW_PORT || 4451);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw Error("Choose a valid CREW_PREVIEW_PORT.");
const vite = await createServer({
  configFile: `${root}vite.config.js`,
  server: { host: "127.0.0.1", port, strictPort: true, open: false },
  plugins: [
    {
      name: "crew-current-ui-preview",
      transformIndexHtml(html) {
        return html.replace(
          /\/src\/(?:manager|agents|setup)\/main\.tsx/g,
          "/src/preview/main.tsx",
        );
      },
      configureServer(server) {
        server.middlewares.use((request, response, next) => {
          response.setHeader(
            "Content-Security-Policy",
            `default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' ws://127.0.0.1:${port}; media-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'self'; form-action 'self'`,
          );
          response.setHeader(
            "Permissions-Policy",
            "microphone=(), camera=(), geolocation=()",
          );
          response.setHeader("X-Content-Type-Options", "nosniff");
          response.setHeader("Referrer-Policy", "no-referrer");
          if (
            request.url?.startsWith("/api/") ||
            request.url?.startsWith("/__control")
          ) {
            response.writeHead(404, { "Content-Type": "application/json" });
            response.end(
              JSON.stringify({
                error: "UI preview has no live API or runtime.",
              }),
            );
            return;
          }
          next();
        });
      },
    },
  ],
});
let closing = false;
const close = async () => {
  if (closing) return;
  closing = true;
  await vite.close();
  process.exit(0);
};
process.once("SIGINT", close);
process.once("SIGTERM", close);
await vite.listen();
console.log(
  `Crew UI preview: http://127.0.0.1:${port} — empty and populated projects, synthetic data only.`,
);
