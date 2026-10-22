import { fileURLToPath } from "node:url";
/** Compiled modules live below runtime; resources and executable entries share this root. */
const base = new URL("../", import.meta.url);
export const runtimeRoot = fileURLToPath(base);
export const resourceURL = (relative: string) => new URL(relative, base);
