plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.idukang.readingcompanion"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.idukang.readingcompanion"
        minSdk = 24
        targetSdk = 34
        versionCode = 1
        versionName = "1.0.0"
    }

    buildTypes {
        debug {
            isMinifyEnabled = false
        }
        release {
            isMinifyEnabled = false
            // 未签名 release 无法直接安装，发布用 debug 签名包（见 README）
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        buildConfig = true
    }
}

dependencies {
    // 无第三方依赖：仅 Kotlin 标准库（由 Kotlin 插件自动加入），APK 体积小、无任何追踪 SDK
}
