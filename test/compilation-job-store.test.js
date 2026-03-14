const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { CompilationJobStore } = require("../compilation-job-store");

test("CompilationJobStore persists jobs to disk", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "365moments-jobs-"));
  const filePath = path.join(tempDir, "compilation-jobs.json");

  try {
    const store = new CompilationJobStore(filePath);
    store.set("user@example.com", {
      id: "job-1",
      status: "compiling",
      progress: "Fetching clips...",
    });

    const reloadedStore = new CompilationJobStore(filePath);
    assert.deepEqual(reloadedStore.get("user@example.com"), {
      id: "job-1",
      status: "compiling",
      progress: "Fetching clips...",
    });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("CompilationJobStore update removes jobs when updater returns null", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "365moments-jobs-"));
  const filePath = path.join(tempDir, "compilation-jobs.json");

  try {
    const store = new CompilationJobStore(filePath);
    store.set("user@example.com", {
      id: "job-1",
      status: "error",
      progress: "Failed",
    });

    store.update("user@example.com", () => null);
    assert.equal(store.get("user@example.com"), null);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
