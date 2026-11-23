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
        versionCode = 2
        versionName = "1.0.1"
    }

    signingConfigs {
        create("release") {
            val sf = System.getenv("RELEASE_STORE_FILE")
            if (!sf.isNullOrBlank()) {
                storeFile = file(sf)
                storeType = "PKCS12"
                storePassword = System.getenv("RELEASE_STORE_PASSWORD") ?: ""
                keyAlias = System.getenv("RELEASE_KEY_ALIAS") ?: "release"
                keyPassword = System.getenv("RELEASE_KEY_PASSWORD") ?: ""
            }
        }
    }

    buildTypes {
        debug {
            isMinifyEnabled = false
        }
        release {
            isMinifyEnabled = false
            val sf = System.getenv("RELEASE_STORE_FILE")
            if (!sf.isNullOrBlank()) {
                signingConfig = signingConfigs.getByName("release")
            }
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
