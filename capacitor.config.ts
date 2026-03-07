import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
    appId: "com.coolmyll.moments365",
    appName: "365 Moments",
    webDir: "public",
    server: {
        url: "https://365.chrismyll.gr",
    },
    plugins: {
        LocalNotifications: {
            smallIcon: "ic_stat_icon",
            iconColor: "#1a1a2e",
        },
    },
    android: {},
};

export default config;
