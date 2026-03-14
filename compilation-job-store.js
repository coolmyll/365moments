const fs = require("fs");
const path = require("path");

class CompilationJobStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.jobs = new Map();
    this.ensureDirectory();
    this.load();
  }

  ensureDirectory() {
    const dirPath = path.dirname(this.filePath);
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
  }

  load() {
    if (!fs.existsSync(this.filePath)) {
      return;
    }

    try {
      const content = fs.readFileSync(this.filePath, "utf8");
      if (!content.trim()) {
        return;
      }

      const parsed = JSON.parse(content);
      if (!Array.isArray(parsed)) {
        return;
      }

      this.jobs = new Map(
        parsed
          .filter((entry) => entry && typeof entry.userId === "string")
          .map((entry) => [entry.userId, entry.job]),
      );
    } catch {
      this.jobs = new Map();
    }
  }

  save() {
    this.ensureDirectory();
    const tempPath = `${this.filePath}.tmp`;
    const payload = JSON.stringify(
      Array.from(this.jobs.entries()).map(([userId, job]) => ({
        userId,
        job,
      })),
      null,
      2,
    );

    fs.writeFileSync(tempPath, payload, "utf8");
    fs.renameSync(tempPath, this.filePath);
  }

  get(userId) {
    return this.jobs.get(userId) || null;
  }

  set(userId, job) {
    this.jobs.set(userId, job);
    this.save();
    return job;
  }

  update(userId, updater) {
    const currentJob = this.get(userId);
    const nextJob = updater(currentJob);

    if (!nextJob) {
      this.jobs.delete(userId);
      this.save();
      return null;
    }

    this.jobs.set(userId, nextJob);
    this.save();
    return nextJob;
  }

  delete(userId) {
    const deleted = this.jobs.delete(userId);
    if (deleted) {
      this.save();
    }
    return deleted;
  }

  entries() {
    return this.jobs.entries();
  }
}

module.exports = {
  CompilationJobStore,
};
