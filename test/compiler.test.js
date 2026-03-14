const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const VideoCompiler = require("../compiler");

test("VideoCompiler fetchClipsList retries transient Drive failures", async () => {
  const compiler = new VideoCompiler({}, { requestId: "test-request" });
  let attempts = 0;

  compiler.drive = {
    files: {
      list: async () => {
        attempts += 1;
        if (attempts === 1) {
          const error = new Error("temporary backend error");
          error.status = 503;
          throw error;
        }

        return {
          data: {
            files: [
              {
                id: "clip-1",
                name: "2026-03-14.mp4",
                createdTime: "2026-03-14T00:00:00.000Z",
                modifiedTime: "2026-03-14T00:00:00.000Z",
              },
            ],
            nextPageToken: null,
          },
        };
      },
    },
  };

  const clips = await compiler.fetchClipsList("folder-1");

  assert.equal(attempts, 2);
  assert.equal(clips.length, 1);
  assert.equal(clips[0].id, "clip-1");
});

test("VideoCompiler uploadToDrive retries transient upload failures", async () => {
  const compiler = new VideoCompiler({}, { requestId: "test-request" });
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "365moments-test-"));
  const filePath = path.join(tempDir, "output.mp4");
  fs.writeFileSync(filePath, "video-data");

  let attempts = 0;
  compiler.drive = {
    files: {
      create: async ({ media }) => {
        await new Promise((resolve, reject) => {
          media.body.on("error", reject);
          media.body.on("end", resolve);
          media.body.resume();
        });

        attempts += 1;
        if (attempts === 1) {
          const error = new Error("rate limit");
          error.status = 429;
          throw error;
        }

        return {
          data: {
            id: "compiled-1",
            name: "output.mp4",
            webViewLink: "https://example.test/output.mp4",
          },
        };
      },
    },
  };

  try {
    const result = await compiler.uploadToDrive(
      filePath,
      "output.mp4",
      "folder-1",
    );

    assert.equal(attempts, 2);
    assert.equal(result.id, "compiled-1");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
