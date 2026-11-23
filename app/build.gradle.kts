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
        versionCode = 3
        versionName = "1.1.0"
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

    // JNA 需要把 .so 解压到 nativeLibraryDir 才能 System.loadLibrary("vosk")，
    // 所以这里用传统打包方式（extractNativeLibs=true）。
    packaging {
        jniLibs {
            useLegacyPackaging = true
        }
    }
}

dependencies {
    // 唯一的一组第三方依赖：离线语音识别（Vosk）。
    // 本地运行、不联网、不上报；模型文件打包在 assets 里。
    implementation("com.alphacephei:vosk-android:0.3.47")
    implementation("net.java.dev.jna:jna:5.13.0@aar")
}
