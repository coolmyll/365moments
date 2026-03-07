import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
    appId: "com.coolmyll.moments365",
    appName: "365 Moments",
    webDir: "public",
    server: {
        // During development, point to your local server so API routes work.
        // Comment this out and run `npx cap copy` for a fully offline-capable build.
        url: "http://10.0.2.2:3000", // Android emulator → host machine
        cleartext: true,
    },
    plugins: {
        LocalNotifications: {
            smallIcon: "ic_stat_icon",
            iconColor: "#1a1a2e",
        },
    },
    android: {
        allowMixedContent: true, // dev only — remove for production
    },
};

export default config;
