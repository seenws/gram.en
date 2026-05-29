import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(import.meta.url), "..", "..");
const port = Number(process.env.PORT ?? 8080);

const content_types: Record<string, string> = {
    ".html": "text/html",
    ".js": "text/javascript",
    ".css": "text/css",
    ".gram": "text/plain",
    ".json": "application/json",
};

createServer(async (req, res) => {
    const url = (req.url ?? "/").split("?")[0];
    const rel = normalize(url === "/" ? "/index.html" : url).replace(/^(\.\.[/\\])+/, "");

    try {
        const data = await readFile(join(root, rel));
        res.writeHead(200, { "content-type": content_types[extname(rel)] ?? "application/octet-stream" });
        res.end(data);
    } catch {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("404 Not Found");
    }
}).listen(port, () => console.log(`serving ${root} at http://localhost:${port}`));
