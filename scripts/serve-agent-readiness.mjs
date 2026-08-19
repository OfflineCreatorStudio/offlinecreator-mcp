import { createServer } from "node:http";
import { handleAgentReadinessRequest } from "../dist/agent-readiness.js";

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? "127.0.0.1";

const server = createServer(async (req, res) => {
  const url = new URL(
    req.url ?? "/",
    `http://${req.headers.host ?? `${host}:${port}`}`,
  );
  const body =
    req.method === "POST" || req.method === "PUT"
      ? await new Promise((resolve, reject) => {
          const chunks = [];
          req.on("data", (chunk) => chunks.push(chunk));
          req.on("end", () => resolve(Buffer.concat(chunks)));
          req.on("error", reject);
        })
      : undefined;
  const request = new Request(url, {
    method: req.method,
    headers: req.headers,
    body,
  });
  const response =
    (await handleAgentReadinessRequest(request)) ??
    new Response("Not found.", { status: 404 });
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
});

server.listen(port, host, () => {
  console.error(`agent-readiness preview listening on http://${host}:${port}`);
});
