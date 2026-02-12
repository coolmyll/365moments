// API Client for 365 Moments

const API = {
  // Check authentication status
  async checkAuth() {
    const response = await fetch("/api/auth/status");
    return response.json();
  },

  // Logout
  async logout() {
    const response = await fetch("/api/auth/logout", { method: "POST" });
    return response.json();
  },

  // Show the permission error screen
  showPermissionError() {
    // Hide all screens
    document
      .querySelectorAll(".screen")
      .forEach((s) => s.classList.remove("active"));
    // Show permission error screen
    document.getElementById("permission-error-screen").classList.add("active");
  },

  // Handle API response and check for reauth requirement
  async handleResponse(response) {
    const data = await response.json();
    if (data.requireReauth) {
      this.showPermissionError();
      throw new Error(data.error);
    }
    if (!response.ok) {
      throw new Error(data.error || "Request failed");
    }
    return data;
  },

  // Get all clips
  async getClips() {
    const response = await fetch("/api/clips");
    return this.handleResponse(response);
  },

  // Upload a video clip
  async uploadClip(blob, fileName) {
    const formData = new FormData();
    formData.append("video", blob, fileName);
    formData.append("fileName", fileName);

    const response = await fetch("/api/clips", {
      method: "POST",
      body: formData,
    });

    return this.handleResponse(response);
  },

  // Get video URL for a clip
  getVideoUrl(clipId) {
    return `/api/clips/${clipId}/video`;
  },

  // Delete a clip
  async deleteClip(clipId) {
    const response = await fetch(`/api/clips/${clipId}`, {
      method: "DELETE",
    });
    return this.handleResponse(response);
  },

  // Request video compilation with date range
  async compileVideo(startDate, endDate, musicData = null) {
    const response = await fetch("/api/compile", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ startDate, endDate, musicData }),
    });
    return this.handleResponse(response);
  },

  // Get compilation status
  async getCompileStatus() {
    const response = await fetch("/api/compile/status");
    return response.json();
  },

  // Clear compilation status
  async clearCompileStatus() {
    const response = await fetch("/api/compile/status", { method: "DELETE" });
    return response.json();
  },

  // Get all compilations
  async getCompilations() {
    const response = await fetch("/api/compilations");
    return this.handleResponse(response);
  },

  // Get compilation video URL
  getCompilationUrl(compilationId) {
    return `/api/compilations/${compilationId}`;
  },

  // Delete a compilation
  async deleteCompilation(compilationId) {
    const response = await fetch(`/api/compilations/${compilationId}`, {
      method: "DELETE",
    });
    return this.handleResponse(response);
  },

  // Upload and trim a video to 1 second
  async uploadAndTrim(file, date, startTime = 0) {
    const formData = new FormData();
    formData.append("video", file);
    formData.append("date", date);
    formData.append("startTime", startTime.toString());

    const response = await fetch("/api/clips/upload-trim", {
      method: "POST",
      body: formData,
    });

    return this.handleResponse(response);
  },
};
// Export for global use
window.API = API;
