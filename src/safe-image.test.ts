import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { StudioApiClient } from "./client.js";
import { readSafeLocalAsset } from "./safe-asset.js";
import { readSafeLocalImage } from "./safe-fs.js";
import {
  decodeSafeImageBase64,
  GIF_INPUT_MESSAGE,
  isGifImage,
  sniffImageType,
} from "./safe-image.js";

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const GIF_1X1 = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
  "base64",
);

const GENERATION_ID = "11111111-1111-4111-8111-111111111111";

describe("safe-image", () => {
  it("sniffs the types Studio accepts and no longer reports GIF as one", () => {
    assert.equal(sniffImageType(PNG_1X1), "image/png");
    assert.equal(
      sniffImageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0])),
      "image/jpeg",
    );
    assert.equal(
      sniffImageType(
        Buffer.concat([
          Buffer.from("RIFF"),
          Buffer.alloc(4),
          Buffer.from("WEBP"),
        ]),
      ),
      "image/webp",
    );
    assert.equal(sniffImageType(GIF_1X1), null);
    assert.equal(isGifImage(GIF_1X1), true);
    assert.equal(isGifImage(Buffer.from("GIF87a....")), true);
    assert.equal(isGifImage(PNG_1X1), false);
    assert.equal(isGifImage(Buffer.from("GIF")), false);
  });

  it("explains how to fix a GIF", () => {
    assert.match(GIF_INPUT_MESSAGE, /PNG, JPEG, or WebP/);
    assert.match(GIF_INPUT_MESSAGE, /Convert/);
    assert.match(GIF_INPUT_MESSAGE, /same generationId/);
    assert.throws(
      () => decodeSafeImageBase64({ imageBase64: GIF_1X1.toString("base64") }),
      (error: Error) => error.message === GIF_INPUT_MESSAGE,
    );
  });

  it("still enforces a declared contentType against the real bytes", () => {
    assert.throws(
      () =>
        decodeSafeImageBase64({
          imageBase64: PNG_1X1.toString("base64"),
          contentType: "image/jpeg",
        }),
      /does not match/,
    );
  });

  describe("upload_input through the client", () => {
    let root: string;
    let requests: Array<{ url: string; contentType: string | null }>;
    let client: StudioApiClient;

    before(async () => {
      root = await mkdtemp(path.join(os.tmpdir(), "oc-mcp-gif-"));
      await writeFile(path.join(root, "anim.gif"), GIF_1X1);
      await writeFile(path.join(root, "still.png"), PNG_1X1);
    });

    after(async () => {
      await rm(root, { recursive: true, force: true });
    });

    before(() => {
      requests = [];
      client = new StudioApiClient({
        apiBase: "https://studio.test",
        apiKey: "oc_test_unit",
        uploadRoot: root,
        readLocalImage: readSafeLocalImage,
        readLocalAsset: readSafeLocalAsset,
        fetcher: (async (url: string | URL | Request, init?: RequestInit) => {
          requests.push({
            url: String(url),
            contentType: new Headers(init?.headers).get("content-type"),
          });
          return new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }) as typeof fetch,
      });
    });

    it("rejects a GIF filePath before any request is sent", async () => {
      await assert.rejects(
        () =>
          client.uploadInput({
            generationId: GENERATION_ID,
            filePath: "anim.gif",
          }),
        /GIF images cannot be used as upload_input/,
      );
      assert.equal(requests.length, 0);
    });

    it("rejects GIF base64, declared or not, before any request is sent", async () => {
      await assert.rejects(
        () =>
          client.uploadInput({
            generationId: GENERATION_ID,
            imageBase64: GIF_1X1.toString("base64"),
            contentType: "image/gif",
          }),
        /PNG, JPEG, or WebP/,
      );
      await assert.rejects(
        () =>
          client.uploadInput({
            generationId: GENERATION_ID,
            imageBase64: GIF_1X1.toString("base64"),
          }),
        /PNG, JPEG, or WebP/,
      );
      assert.equal(requests.length, 0);
    });

    it("still uploads a PNG", async () => {
      await client.uploadInput({
        generationId: GENERATION_ID,
        filePath: "still.png",
      });
      assert.equal(requests.length, 1);
      assert.match(requests[0]!.url, /\/generations\/.+\/input$/);
      assert.equal(requests[0]!.contentType, "image/png");
    });
  });
});
