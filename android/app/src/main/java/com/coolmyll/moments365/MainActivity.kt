package com.coolmyll.moments365

import android.app.DownloadManager
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.os.Environment
import android.view.View
import android.view.Window
import android.webkit.URLUtil
import android.widget.Toast
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import com.getcapacitor.BridgeActivity

class MainActivity : BridgeActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        registerPlugin(OneSecondRecorderPlugin::class.java)
        super.onCreate(savedInstanceState)
    }

    override fun onStart() {
        super.onStart()

        WindowCompat.setDecorFitsSystemWindows(window, false)
        val currentWindow: Window = window
        currentWindow.statusBarColor = Color.parseColor("#16213e")

        val contentView = findViewById<View>(android.R.id.content)
        contentView?.setOnApplyWindowInsetsListener { view, insets ->
            val systemBarsTop =
                insets.getInsets(WindowInsetsCompat.Type.systemBars()).top
            view.setPadding(0, systemBarsTop, 0, 0)
            insets
        }

        bridge.webView.setDownloadListener { url, userAgent, contentDisposition, mimetype, _ ->
            try {
                val request = DownloadManager.Request(Uri.parse(url))
                request.setMimeType(mimetype)
                
                // Add cookies if needed
                val cookies = android.webkit.CookieManager.getInstance().getCookie(url)
                if (cookies != null) {
                    request.addRequestHeader("cookie", cookies)
                }
                
                request.addRequestHeader("User-Agent", userAgent)
                request.setDescription("Downloading video...")
                
                val filename = URLUtil.guessFileName(url, contentDisposition, mimetype)
                request.setTitle(filename)
                
                request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                request.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, filename)
                
                val dm = getSystemService(DOWNLOAD_SERVICE) as DownloadManager
                dm.enqueue(request)
                
                Toast.makeText(applicationContext, "Downloading $filename...", Toast.LENGTH_SHORT).show()
            } catch (e: Exception) {
                e.printStackTrace()
                Toast.makeText(applicationContext, "Download failed", Toast.LENGTH_SHORT).show()
            }
        }
    }
}