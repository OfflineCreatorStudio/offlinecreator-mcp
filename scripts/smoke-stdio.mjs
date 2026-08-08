import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import packageMetadata from "../package.json" with { type: "json" };

const child = spawn(process.execPath, ["dist/index.js"], {
  env: {
    ...process.env,
    OFFLINECREATOR_API_KEY: "oc_test_smoke",
  },
  stdio: ["pipe", "pipe", "pipe"],
});

let stdout = "";
let stderr = "";
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  stdout += chunk;
});
child.stderr.on("data", (chunk) => {
  stderr += chunk;
});

const timeout = setTimeout(() => {
  child.kill();
}, 10_000);

child.stdin.write(
  `${JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "release-smoke", version: packageMetadata.version },
    },
  })}\n`,
);

try {
  const response = await new Promise((resolve, reject) => {
    const inspect = () => {
      for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
        try {
          const message = JSON.parse(line);
          if (message.id === 1) return resolve(message);
        } catch {
          // Wait for a complete newline-delimited JSON-RPC message.
        }
      }
    };
    child.stdout.on("data", inspect);
    child.once("error", reject);
    child.once("exit", (code) => {
      inspect();
      reject(
        new Error(
          `stdio server exited before initialize response (${code}).\n${stderr}`,
        ),
      );
    });
  });

  assert.equal(response.jsonrpc, "2.0");
  assert.equal(response.result?.serverInfo?.name, "offlinecreator-studio");
  assert.equal(response.result?.serverInfo?.version, packageMetadata.version);
  assert.ok(
    response.result?.capabilities?.tools,
    "Initialize response must advertise tools.",
  );
  console.log("stdio initialize smoke test passed.");
} finally {
  clearTimeout(timeout);
  child.stdin.end();
  child.kill();
}
