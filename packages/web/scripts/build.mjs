import { cpSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { build } from "esbuild";

const root = new URL("..", import.meta.url).pathname;
const publicDir = join(root, "dist", "public");

rmSync(publicDir, { force: true, recursive: true });
mkdirSync(publicDir, { recursive: true });
cpSync(join(root, "src", "client", "index.html"), join(publicDir, "index.html"));
cpSync(join(root, "src", "client", "styles.css"), join(publicDir, "styles.css"));
cpSync(join(root, "src", "client", "favicon.svg"), join(publicDir, "favicon.svg"));

await build({
	bundle: true,
	entryPoints: [join(root, "src", "client", "app.ts")],
	format: "esm",
	minify: true,
	outfile: join(publicDir, "app.js"),
	platform: "browser",
	target: "es2022",
});
