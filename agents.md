# 365 Moments - Development Guide for AI Agents

## Project Overview

**365 Moments** is a mobile-first Progressive Web App (PWA) that lets users capture one-second video clips every day for a year, creating a year-long video diary. The app is built with Node.js/Express for the backend and uses Capacitor to wrap the web app as a native Android application.

### Key Features

- 📱 Mobile-first PWA with native Android app support
- 🎥 1-second video recording with countdown timer
- 📸 Portrait/Landscape orientation toggle
- 🔄 Front/Back camera switching
- ☁️ Google Drive integration for video storage
- 📅 Calendar gallery view for recordings
- 📤 Upload existing videos/images with trimming
- 🎬 Video compilation with date range selection
- 🔔 Daily local notifications (Android)
- ⚡ Smart upload - H.264 MP4 files skip re-encoding

---

## Tech Stack

### Backend

- **Runtime**: Node.js v20+ (Alpine-based Docker image)
- **Framework**: Express.js v5
- **Session Storage**: Redis (production) / File-based (development)
- **Video Processing**: FFmpeg (via `ffmpeg-static`)
- **Google APIs**: Google Drive API for video storage

### Frontend

- **Platform**: Vanilla JavaScript (no framework)
- **Mobile**: Capacitor v8 with Android platform
- **Camera**: CameraX (Android native) / MediaRecorder (web fallback)

### Mobile (Android)

- **SDK**: compileSdk 36, targetSdk 36, minSdk 24
- **Camera**: CameraX v1.3.4 for native video recording
- **Capacitor Plugins**: Camera, Browser, Filesystem, Local Notifications

---

## Project Structure

```
365moments/
├── public/                 # Web assets (served as static files)
│   ├── index.html         # Main HTML entry point
│   ├── manifest.json      # PWA manifest
│   ├── icon.png           # App icon
│   ├── styles.css         # Main stylesheet
│   └── js/                # JavaScript modules
│       ├── app.js         # Main application logic
│       ├── api.js         # API client
│       ├── config.js      # Configuration constants
│       ├── native-auth.js # Deep-link authentication
│       ├── native-recorder.js # Native video recorder (Android)
│       ├── recorder.js    # Web video recorder (fallback)
│       ├── notifications.js # Notification handling
│       └── platform.js    # Platform detection
├── server.js              # Express server entry point
├── compiler.js            # Video compilation service
├── capacitor.config.ts    # Capacitor configuration
├── package.json           # Dependencies and scripts
├── .env.example           # Environment variable template
├── Dockerfile             # Docker image definition
├── docker-compose.yml     # Docker Compose setup
├── android/               # Android native project
│   ├── app/
│   │   └── src/main/
│   │       ├── java/com/coolmyll/moments365/
│   │       │   ├── MainActivity.java
│   │       │   └── OneSecondRecorderPlugin.java # Custom Capacitor plugin
│   │       └── AndroidManifest.xml
│   └── build.gradle
└── .github/               # GitHub workflows
```

---

## Environment Variables

Copy `.env.example` to `.env` and fill in your values:

```env
# Google OAuth 2.0 Credentials
GOOGLE_CLIENT_ID=your_client_id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your_client_secret

# Session Secret (generate a random string)
SESSION_SECRET=your-super-secret-session-key-change-this

# Server Configuration
PORT=3000
NODE_ENV=development

# Base URL (for OAuth redirect)
BASE_URL=http://localhost:3000

# Redis URL (for production session storage)
REDIS_URL=redis://redis:6379
```

### Google Cloud Setup

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project
3. Enable **Google Drive API**
4. Configure OAuth Consent Screen:
   - User type: "External"
   - Scopes: `drive.file`, `userinfo.profile`, `userinfo.email`
5. Create OAuth 2.0 Credentials:
   - Application type: "Web application"
   - Authorized redirect URIs: `http://localhost:3000/auth/callback`

---

## Development Commands

### Prerequisites

- **Node.js** v20 or higher
- **npm** v8 or higher
- **FFmpeg** (bundled via `ffmpeg-static`, no separate install needed for development)
- **Android SDK** (for Android development)

### Installation

```bash
npm install
```

### Running the Application

| Command       | Description                                         |
| ------------- | --------------------------------------------------- |
| `npm start`   | Start production server                             |
| `npm run dev` | Start development server with auto-reload (nodemon) |

### Capacitor Commands

| Command            | Description                                |
| ------------------ | ------------------------------------------ |
| `npm run cap:init` | Initialize Capacitor with Android platform |
| `npm run cap:sync` | Sync web assets to Android platform        |
| `npm run cap:open` | Open Android project in Android Studio     |
| `npm run cap:run`  | Build and run on connected Android device  |

### Docker Commands

| Command                        | Description                                 |
| ------------------------------ | ------------------------------------------- |
| `docker build -t 365moments .` | Build Docker image                          |
| `docker-compose up`            | Start app with Redis (requires `.env` file) |
| `docker-compose down`          | Stop and remove containers                  |

---

## Compilation & Video Processing

### Video Compilation Service

The [`compiler.js`](compiler.js) module handles video compilation using FFmpeg. Key features:

- Fetches clips from Google Drive
- Downloads clips to local temp directory
- Concatenates videos using FFmpeg
- Supports music overlay
- Progress tracking via callback

### Compilation Job API

The server tracks compilation jobs via the `/api/compile` endpoint:

- **POST** `/api/compile` - Start a new compilation job
- **GET** `/api/compile/status` - Check job status
- **GET** `/api/compile/result` - Get compilation result

### Compilation Requirements

- Minimum 7 clips for production (2 for development)
- All clips must be H.264 MP4 format
- Videos are compiled in date order

---

## Android Native Development

### Custom Capacitor Plugin

The [`OneSecondRecorderPlugin.java`](android/app/src/main/java/com/coolmyll/moments365/OneSecondRecorderPlugin.java) provides native 1-second video recording using CameraX:

- Records exactly 1 second of video
- Outputs H.264 MP4 format
- Supports front/back camera switching
- Handles orientation automatically

### Android Build Requirements

- **compileSdk**: 36
- **targetSdk**: 36
- **minSdk**: 24 (Android 7.0)
- **CameraX**: 1.3.4

### Android Permissions

The app requires the following permissions (declared in `AndroidManifest.xml`):

- `CAMERA` - For video recording
- `RECORD_AUDIO` - For audio in videos
- `WRITE_EXTERNAL_STORAGE` - For video storage (Android < 10)
- `READ_EXTERNAL_STORAGE` - For video access

### Building Android APK

```bash
# Sync web assets first
npm run cap:sync

# Open in Android Studio
npm run cap:open

# Or build via CLI
cd android
./gradlew assembleDebug
```

The APK will be at `android/app/build/outputs/apk/debug/app-debug.apk`.

---

## Code Organization

### Server Modules

| File                         | Purpose                                         |
| ---------------------------- | ----------------------------------------------- |
| [`server.js`](server.js)     | Express server, API routes, OAuth, file uploads |
| [`compiler.js`](compiler.js) | Video compilation service using FFmpeg          |

### Frontend Modules

| File                                                 | Purpose                               |
| ---------------------------------------------------- | ------------------------------------- |
| [`app.js`](public/js/app.js)                         | Main application logic, UI management |
| [`api.js`](public/js/api.js)                         | API client for server communication   |
| [`native-recorder.js`](public/js/native-recorder.js) | Native video recorder (Android)       |
| [`recorder.js`](public/js/recorder.js)               | Web video recorder (fallback)         |
| [`native-auth.js`](public/js/native-auth.js)         | Deep-link authentication handler      |

---

## Common Development Tasks

### Adding a New API Endpoint

1. Add route in [`server.js`](server.js) (around line 100-200)
2. Add client function in [`api.js`](public/js/api.js)
3. Update frontend to use the new endpoint

### Modifying Video Recording

- **Web**: Modify [`recorder.js`](public/js/recorder.js)
- **Android**: Modify [`OneSecondRecorderPlugin.java`](android/app/src/main/java/com/coolmyll/moments365/OneSecondRecorderPlugin.java)

### Changing Compilation Settings

Edit [`compiler.js`](compiler.js):

- `minClips`: Minimum clips required (line 29)
- `TEMP_DIR`: Temporary directory for compilation (line 16)

---

## Debugging

### Server Logs

```bash
# Development with verbose logging
DEBUG=* npm run dev

# Check server output
node server.js
```

### Android Logs

```bash
# View logs via ADB
adb logcat | grep -i "365moments\|OneSecondRecorder"

# Or use Android Studio's Logcat
```

### Browser DevTools

Open DevTools (F12) in the browser to debug frontend issues.

---

## Best Practices

### Code Style

1. **Consistent naming**: Use camelCase for JavaScript, PascalCase for classes
2. **Error handling**: Always wrap async operations in try-catch
3. **Logging**: Use `console.log()` with descriptive messages
4. **Comments**: Document complex logic, especially in `compiler.js`

### Git Workflow

1. Create a feature branch: `git checkout -b feature/your-feature`
2. Commit changes with clear messages
3. Push and create a pull request

### Security

1. **Never commit `.env`**: It contains sensitive credentials
2. **Use environment variables**: For all configuration
3. **Session management**: Sessions expire after 7 days
4. **OAuth scopes**: Request only necessary permissions

### Performance

1. **Video encoding**: H.264 MP4 files skip re-encoding
2. **Session storage**: Use Redis in production for scalability
3. **Temp files**: Clean up temp directory regularly
4. **Memory**: Monitor memory usage during compilation

---

## Troubleshooting

### Common Issues

| Issue                  | Solution                                              |
| ---------------------- | ----------------------------------------------------- |
| Camera not working     | Check permissions in AndroidManifest.xml              |
| OAuth redirect fails   | Verify BASE_URL matches your deployment               |
| Compilation fails      | Check FFmpeg installation, temp directory permissions |
| Redis connection fails | Verify REDIS_URL in .env file                         |
| Android build fails    | Clean project: `cd android && ./gradlew clean`        |

### Debug Mode

Set `NODE_ENV=development` for verbose logging and relaxed compilation requirements (min 2 clips instead of 7).

---

## Deployment

### Production Checklist

- [ ] Set `NODE_ENV=production`
- [ ] Configure Redis URL
- [ ] Set correct `BASE_URL`
- [ ] Enable HTTPS
- [ ] Configure proper OAuth redirect URIs
- [ ] Set up monitoring/logging

### Docker Deployment

```bash
# Build and run with Docker Compose
docker-compose up -d

# View logs
docker-compose logs -f

# Update to latest version
docker-compose pull
docker-compose up -d
```

### Railway Deployment

1. Push to GitHub
2. Connect repo to [Railway](https://railway.app)
3. Set environment variables in Railway dashboard
4. Deploy

---

## Contributing

When contributing to this project:

1. Follow the existing code style
2. Test changes on both web and Android
3. Update documentation as needed
4. Test video compilation with various file formats
5. Verify OAuth flow works correctly

---

## License

This project is licensed under the AGPL-3.0-only License. See [`LICENSE`](LICENSE) for details.

---

## Support

For issues and feature requests, please open an issue on GitHub.
