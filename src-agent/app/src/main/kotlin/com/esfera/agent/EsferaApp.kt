package com.esfera.agent

import android.app.Application
import com.esfera.agent.shizuku.ShizukuManager

class EsferaApp : Application() {
    override fun onCreate() {
        super.onCreate()
        ShizukuManager.init()
    }
}
