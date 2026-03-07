# 365 Moments

📹 Record 1 second every day. Create your year in 365 seconds.

A Node.js web app that lets you capture daily 1-second video moments and saves them directly to your Google Drive.

## Features

- 📱 **Mobile-first PWA** - Works on any device with a camera
- 📲 **Native Android app** - Capacitor-powered with native capture & notifications
- 🎥 **1-second video recording** - Quick daily captures with countdown
- 📸 **Portrait/Landscape toggle** - Choose your recording orientation
- 🔄 **Front/Back camera switch** - Easily switch cameras
- ☁️ **Google Drive integration** - Your videos, your storage
- 📅 **Calendar gallery view** - See your recording history at a glance
- 📤 **Upload existing videos/images** - Trim videos or upload photos for any date
- 🎬 **Video compilation** - Combine clips into one video with date range selection
- 🖼️ **Thumbnail previews** - Auto-generated thumbnails for quick browsing
- 📊 **Background compilation** - Compile videos without blocking the UI
- 🔔 **Daily reminders** - Local notifications so you never miss a day (Android)
- ⚡ **Smart upload** - H.264 MP4 files skip server-side re-encoding

## Quick Start

### Prerequisites

- **Node.js** v18 or higher
- **npm** v8 or higher
- **FFmpeg** (bundled via `ffmpeg-static`, no separate install needed)

### 1. Clone and Install

```bash
git clone https://github.com/coolmyll/365moments.git
cd 365moments
npm install
```

### 2. Set Up Google Cloud Credentials

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project (or select existing)
3. Enable the **Google Drive API**:
   - Go to "APIs & Services" → "Library"
   - Search for "Google Drive API" and enable it
4. Configure OAuth Consent Screen:
   - Go to "APIs & Services" → "OAuth consent screen"
   - Choose "External" user type
   - Fill in app name: "365 Moments"
   - Add scopes: `drive.file`, `userinfo.profile`, `userinfo.email`
5. Create OAuth 2.0 Credentials:
   - Go to "APIs & Services" → "Credentials"
   - Click "Create Credentials" → "OAuth client ID"
   - Application type: "Web application"
   - Name: "365 Moments"
   - Authorized redirect URIs: `http://localhost:3000/auth/callback`
   - Copy **Client ID** and **Client Secret**

### 3. Configure Environment

```bash
# Copy the example env file
cp .env.example .env
```

Edit `.env` with your credentials:

```env
GOOGLE_CLIENT_ID=your_client_id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your_client_secret
SESSION_SECRET=generate-a-random-secret-here
PORT=3000
BASE_URL=http://localhost:3000
```

### 4. Run the App

```bash
# Development (with auto-reload)
npm run dev

# Production
npm start
```

Open `http://localhost:3000` in your browser.

### 5. First Login

1. Click "Sign in with Google"
2. Select your Google account
3. **Important:** Check the "See, create, and delete its own configuration data in your Google Drive" checkbox
4. Click "Continue"

If you miss the checkbox, you'll see a "Permission Required" screen - just log out and try again.

## Deployment (Railway)

1. Push to GitHub
2. Connect repo to [Railway](https://railway.app)
3. Add environment variables:
   - `GOOGLE_CLIENT_ID`
   - `GOOGLE_CLIENT_SECRET`
   - `SESSION_SECRET`
   - `BASE_URL` (your Railway URL, e.g., `https://365moments-production.up.railway.app`)
   - `NODE_ENV=production`
4. Update Google Cloud Console with production callback URL

## Project Structure

```
365moments/
├── server.js              # Express server with API routes
├── compiler.js            # FFmpeg video compilation service
├── capacitor.config.ts    # Capacitor native app configuration
├── package.json           # Dependencies
├── .env.example           # Environment template
├── Dockerfile             # Docker image build
├── docker-compose.yml     # Docker Compose setup
├── nodemon.json           # Dev auto-reload config
├── LICENSE                # AGPL-3.0 license
├── public/
│   ├── index.html         # Main HTML
│   ├── styles.css         # Styling
│   ├── manifest.json      # PWA manifest
│   └── js/
│       ├── config.js      # Client configuration
│       ├── platform.js    # Platform detection (web vs native)
│       ├── api.js         # API client
│       ├── recorder.js    # Video recording (web/browser)
│       ├── native-recorder.js  # Video recording (Capacitor/native)
│       ├── notifications.js    # Daily reminder notifications
│       └── app.js         # Main app logic
├── android/               # Capacitor Android project
└── README.md
```

## API Endpoints

| Method | Endpoint                 | Description                  |
| ------ | ------------------------ | ---------------------------- |
| GET    | `/auth/login`            | Start Google OAuth flow      |
| GET    | `/auth/callback`         | OAuth callback handler       |
| GET    | `/api/auth/status`       | Check authentication status  |
| POST   | `/api/auth/logout`       | Logout user                  |
| GET    | `/api/clips`             | Get all video clips          |
| POST   | `/api/clips`             | Upload a recorded clip       |
| POST   | `/api/clips/upload-trim` | Upload and trim video/image  |
| GET    | `/api/clips/:id/video`   | Stream a clip video          |
| DELETE | `/api/clips/:id`         | Delete a clip                |
| GET    | `/api/thumbnails/:id`    | Get thumbnail image          |
| POST   | `/api/compile`           | Start background compilation |
| GET    | `/api/compile/status`    | Check compilation progress   |
| GET    | `/api/compilations`      | List all compilations        |
| DELETE | `/api/compilations/:id`  | Delete a compilation         |

## Video Compilation

FFmpeg is bundled via `ffmpeg-static` - no separate installation required!

The compilation:

- Normalizes all clips to 1920x1080 with letterboxing
- Converts images to 1-second video clips
- Adds date overlay (dd-mm-yyyy format)
- Runs in the background with progress tracking
- Saves the final video to your Google Drive

## Browser Support

- ✅ Chrome (Desktop & Android)
- ✅ Edge
- ✅ Firefox
- ⚠️ Safari (limited MediaRecorder support)
- ⚠️ iOS Safari (requires HTTPS for camera)

## Android App (Capacitor)

The app includes a Capacitor-based Android project for a native app experience.

### Prerequisites

- **Android Studio** (latest stable)
- **JDK 17+**
- All web prerequisites above

### Build & Run

```bash
# Start the backend server first
npm run dev

# Sync web assets to the Android project
npm run cap:sync

# Open in Android Studio
npm run cap:open

# Or run directly on a connected device/emulator
npm run cap:run
```

### Development Notes

- The Capacitor config (`capacitor.config.ts`) points to `http://10.0.2.2:3000` for dev, which routes the Android emulator to your host machine's server.
- For a physical device, change the server URL to your machine's local IP.
- For production, remove the `server.url` from the config and run `npx cap sync` to bundle the web assets into the APK.
- The app uses native camera capture on Android via Capacitor plugins and falls back to MediaRecorder in the WebView if the plugin is unavailable.
- Daily reminder notifications are scheduled automatically at 8 PM (configurable).
- H.264 MP4 files from native capture skip server-side FFmpeg re-encoding.

### Production Build

1. Remove or comment out `server.url` and `server.cleartext` in `capacitor.config.ts`
2. Set `android.allowMixedContent` to `false`
3. Remove `android:usesCleartextTraffic="true"` from `AndroidManifest.xml`
4. Run `npx cap sync android`
5. Build a signed APK/AAB in Android Studio

## Privacy

- All videos are stored in **your own Google Drive**
- Server only temporarily processes videos during compilation
- We use the `drive.file` scope - we can only access files created by this app

## License

AGPL-3.0 - See [LICENSE](LICENSE) for details.
