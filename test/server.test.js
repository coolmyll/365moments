const test = require("node:test");
const assert = require("node:assert/strict");

const {
  validateCompileRequest,
  parseStartTime,
  normalizeClipFileName,
} = require("../server");

test("validateCompileRequest accepts a bounded valid request", () => {
  const result = validateCompileRequest({
    startDate: "2026-01-01",
    endDate: "2026-12-31",
    musicData: "data:audio/mpeg;base64,QUJDRA==",
  });

  assert.deepEqual(result, {
    startDate: "2026-01-01",
    endDate: "2026-12-31",
    musicData: "data:audio/mpeg;base64,QUJDRA==",
  });
});

test("validateCompileRequest rejects inverted date ranges", () => {
  const result = validateCompileRequest({
    startDate: "2026-12-31",
    endDate: "2026-01-01",
  });

  assert.equal(result.error, "startDate must be before or equal to endDate");
});

test("validateCompileRequest rejects unsupported music payloads", () => {
  const result = validateCompileRequest({
    musicData: "data:audio/wav;base64,AAAA",
  });

  assert.equal(result.error, "musicData must be an MP3 data URL");
});

test("parseStartTime rejects non-finite values", () => {
  assert.equal(
    parseStartTime("Infinity").error,
    "startTime must be a finite number",
  );
});

test("normalizeClipFileName only accepts YYYY-MM-DD based filenames", () => {
  assert.equal(normalizeClipFileName("2026-03-14.webm"), "2026-03-14.mp4");
  assert.equal(normalizeClipFileName("../escape.mp4"), null);
});
