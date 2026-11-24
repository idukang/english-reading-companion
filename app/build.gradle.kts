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
        versionCode = 8
        versionName = "1.3.0"

        // 只打包手机常用的两种架构：x86/x86_64 是模拟器用的，打进来只会让包更大
        ndk {
            abiFilters += listOf("arm64-v8a", "armeabi-v7a")
        }
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

    // sherpa-onnx 的 JNI 库需要落到 nativeLibraryDir 才能 System.loadLibrary，
    // 所以这里用传统打包方式（extractNativeLibs=true）。
    packaging {
        jniLibs {
            useLegacyPackaging = true
        }
    }
}

dependencies {
    // 唯一的第三方依赖：Sherpa-ONNX 离线语音（SenseVoiceSmall + Silero VAD）。
    // AAR 不进仓库，由 scripts/ci-build.sh（或本地构建）下载到 app/libs/。
    // 本地运行、不联网、不上报；模型文件打包在 assets 里。
    implementation(files("libs/sherpa-onnx-2.0.3.aar"))
}
