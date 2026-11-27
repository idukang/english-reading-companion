#!/usr/bin/env bash
# =============================================================================
# 英语陪读 —— GitHub Actions 自建构建脚本
# 在 ubuntu-latest 上从零准备好 JDK 17 / Android SDK / Gradle 8.7，
# 下载 SenseVoice + Silero VAD 离线语音模型，以及 Supertonic 离线神经音色模型，
# 一起打进 assets，生成 Release APK 与校验文件，并发布到 Release v1.5.0。
# 这样做的原因：workflow 文件只需要一行 `bash scripts/ci-build.sh`，
# 构建逻辑放在普通文件里，后续调整不用改 workflow。
# =============================================================================
set -euo pipefail

echo "::group::环境信息"
uname -a
echo "工作目录: $(pwd)"
echo "GITHUB_REF=${GITHUB_REF:-unknown}"
echo "磁盘:" && df -h / | tail -1
echo "::endgroup::"

# ---------------------------------------------------------------- JDK 17 ----
if [ -n "${JAVA_HOME_17_X64:-}" ] && [ -x "${JAVA_HOME_17_X64}/bin/java" ]; then
  export JAVA_HOME="${JAVA_HOME_17_X64}"
fi

if [ -z "${JAVA_HOME:-}" ] || [ ! -x "${JAVA_HOME}/bin/java" ]; then
  for cand in /usr/lib/jvm/*17* /usr/lib/jvm/*-17-* /opt/hostedtoolcache/Java_Temurin-Hotspot_jdk/17*/x64; do
    if [ -d "$cand" ] && [ -x "$cand/bin/java" ]; then
      export JAVA_HOME="$cand"
      break
    fi
  done
fi

if [ -z "${JAVA_HOME:-}" ] || [ ! -x "${JAVA_HOME}/bin/java" ]; then
  echo "找不到 JDK 17，尝试安装 temurin-17"
  sudo apt-get update -qq
  sudo apt-get install -y -qq openjdk-17-jdk-headless
  export JAVA_HOME="$(dirname "$(dirname "$(readlink -f "$(command -v javac)")")")"
fi

export PATH="${JAVA_HOME}/bin:${PATH}"
echo "JAVA_HOME=${JAVA_HOME}"
java -version

# ------------------------------------------------------------ Android SDK ---
export ANDROID_HOME="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-/usr/local/lib/android/sdk}}"
export ANDROID_SDK_ROOT="${ANDROID_HOME}"
mkdir -p "${ANDROID_HOME}"
echo "ANDROID_HOME=${ANDROID_HOME}"

find_sdkmanager() {
  local c
  for c in \
    "${ANDROID_HOME}/cmdline-tools/latest/bin/sdkmanager" \
    "${ANDROID_HOME}/cmdline-tools/bin/sdkmanager" \
    "${ANDROID_HOME}/tools/bin/sdkmanager"; do
    if [ -x "$c" ]; then
      echo "$c"
      return 0
    fi
  done
  if command -v sdkmanager >/dev/null 2>&1; then
    command -v sdkmanager
    return 0
  fi
  return 1
}

SDKMANAGER="$(find_sdkmanager || true)"

if [ -z "${SDKMANAGER}" ]; then
  echo "未找到 sdkmanager，下载 commandline-tools"
  mkdir -p "${ANDROID_HOME}/cmdline-tools"
  curl -fsSL -o /tmp/cmdline-tools.zip \
    https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip
  unzip -q -o /tmp/cmdline-tools.zip -d /tmp/cmdline-unpack
  rm -rf "${ANDROID_HOME}/cmdline-tools/latest"
  mv /tmp/cmdline-unpack/cmdline-tools "${ANDROID_HOME}/cmdline-tools/latest"
  SDKMANAGER="${ANDROID_HOME}/cmdline-tools/latest/bin/sdkmanager"
fi
echo "sdkmanager=${SDKMANAGER}"

echo "接受 SDK 许可"
yes 2>/dev/null | "${SDKMANAGER}" --licenses >/dev/null 2>&1 || true

MISSING=""
[ -d "${ANDROID_HOME}/platforms/android-34" ] || MISSING="${MISSING} platforms;android-34"
[ -d "${ANDROID_HOME}/build-tools/34.0.0" ] || MISSING="${MISSING} build-tools;34.0.0"
[ -d "${ANDROID_HOME}/platform-tools" ] || MISSING="${MISSING} platform-tools"

if [ -n "${MISSING}" ]; then
  echo "安装缺失组件:${MISSING}"
  # shellcheck disable=SC2086
  yes 2>/dev/null | "${SDKMANAGER}" ${MISSING} >/dev/null || true
else
  echo "SDK 34 与 build-tools 34.0.0 已存在，跳过安装"
fi

# 兜底：如果 sdkmanager 没装上，直接下载 platform 与 build-tools 太脆，这里只做校验
if [ ! -d "${ANDROID_HOME}/platforms/android-34" ]; then
  echo "::error::缺少 platforms/android-34，无法编译（compileSdk 34）"
  exit 1
fi

# ---------------------------------------------------------------- Gradle ----
GRADLE_VERSION="8.7"
GRADLE_DIR="/tmp/gradle-${GRADLE_VERSION}"
GRADLE_BIN="${GRADLE_DIR}/bin/gradle"

if [ ! -x "${GRADLE_BIN}" ]; then
  echo "下载 Gradle ${GRADLE_VERSION}"
  curl -fsSL -o /tmp/gradle.zip \
    "https://services.gradle.org/distributions/gradle-${GRADLE_VERSION}-bin.zip"
  rm -rf "/tmp/gradle-${GRADLE_VERSION}"
  unzip -q -o /tmp/gradle.zip -d /tmp
fi

if [ ! -x "${GRADLE_BIN}" ]; then
  echo "::error::Gradle ${GRADLE_VERSION} 准备失败"
  exit 1
fi
"${GRADLE_BIN}" --version


# -------------------------------------------- 离线语音（Sherpa-ONNX） -----
# AAR 与模型都不进仓库：构建时下载。
#   · sherpa-onnx-2.0.3.aar          → app/libs/
#   · SenseVoiceSmall int8 2024-07-17 → assets/sense-voice/{model.int8.onnx,tokens.txt}
#     （2025-09-09 的 int8 包实际是粤语微调版 WSYue，英文/中文明显退化，不能用）
#   · silero_vad_v4.onnx              → assets/silero_vad_v4.onnx
mkdir -p app/libs
SHERPA_AAR="app/libs/sherpa-onnx-2.0.3.aar"
if [ ! -s "${SHERPA_AAR}" ]; then
  echo "下载 sherpa-onnx AAR"
  curl -fL --retry 3 --retry-delay 2 -o "${SHERPA_AAR}" \
    "https://github.com/k2-fsa/sherpa-onnx/releases/download/v2.0.3/sherpa-onnx-2.0.3.aar"
fi
if [ ! -s "${SHERPA_AAR}" ]; then
  echo "::error::sherpa-onnx AAR 下载失败"
  exit 1
fi
echo "sherpa AAR：$(du -h "${SHERPA_AAR}" | cut -f1)"

SV_DIR="app/src/main/assets/sense-voice"
if [ ! -s "${SV_DIR}/model.int8.onnx" ] || [ ! -s "${SV_DIR}/tokens.txt" ]; then
  echo "下载 SenseVoiceSmall int8 模型"
  curl -fL --retry 3 --retry-delay 2 -o /tmp/sensevoice.tar.bz2 \
    "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17.tar.bz2"
  rm -rf /tmp/sv-unpack && mkdir -p /tmp/sv-unpack
  if ! tar -xjf /tmp/sensevoice.tar.bz2 -C /tmp/sv-unpack 2>/dev/null; then
    echo "tar 解 bz2 失败，改用 python3"
    python3 -c "import tarfile;tarfile.open('/tmp/sensevoice.tar.bz2','r:bz2').extractall('/tmp/sv-unpack')"
  fi
  SRC="$(find /tmp/sv-unpack -name model.int8.onnx -printf '%h\n' | head -1)"
  if [ -z "${SRC}" ]; then
    echo "::error::SenseVoice 模型解包失败"
    exit 1
  fi
  mkdir -p "${SV_DIR}"
  cp "${SRC}/model.int8.onnx" "${SRC}/tokens.txt" "${SV_DIR}/"
  rm -f /tmp/sensevoice.tar.bz2
fi
if [ ! -s "${SV_DIR}/model.int8.onnx" ] || [ ! -s "${SV_DIR}/tokens.txt" ]; then
  echo "::error::SenseVoice 模型不完整"
  exit 1
fi
echo "SenseVoice 模型：$(du -sh "${SV_DIR}" | cut -f1)"

VAD_FILE="app/src/main/assets/silero_vad_v4.onnx"
if [ ! -s "${VAD_FILE}" ]; then
  echo "下载 Silero VAD v4"
  curl -fL --retry 3 --retry-delay 2 -o "${VAD_FILE}" \
    "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad_v4.onnx"
fi
if [ ! -s "${VAD_FILE}" ]; then
  echo "::error::Silero VAD 模型下载失败"
  exit 1
fi

# -------------------------------------- 离线神经音色（Supertonic） -----
# 英文朗读用的端上神经 TTS，四件套 + indexer + voice + tts.json，共约 92MB。
# sherpa-onnx 2.0 起已移除 espeak-ng，Piper 的 VITS 模型无法直接使用，
# 因此选用同一发布页里官方支持的 Supertonic int8 模型（44.1kHz、10 个音色）。
TTS_DIR="app/src/main/assets/tts"
if [ ! -s "${TTS_DIR}/voice.bin" ] || [ ! -s "${TTS_DIR}/vector_estimator.int8.onnx" ]; then
  echo "下载 Supertonic 离线神经音色模型"
  curl -fL --retry 3 --retry-delay 2 -o /tmp/supertonic.tar.bz2 \
    "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/sherpa-onnx-supertonic-tts-int8-2026-03-06.tar.bz2"
  rm -rf /tmp/tts-unpack && mkdir -p /tmp/tts-unpack
  if ! tar -xjf /tmp/supertonic.tar.bz2 -C /tmp/tts-unpack 2>/dev/null; then
    echo "tar 解 bz2 失败，改用 python3"
    python3 -c "import tarfile;tarfile.open('/tmp/supertonic.tar.bz2','r:bz2').extractall('/tmp/tts-unpack')"
  fi
  SRC="$(find /tmp/tts-unpack -name voice.bin -printf '%h\n' | head -1)"
  if [ -z "${SRC}" ]; then
    echo "::error::Supertonic 模型解包失败"
    exit 1
  fi
  mkdir -p "${TTS_DIR}"
  cp "${SRC}/duration_predictor.int8.onnx" \
     "${SRC}/text_encoder.int8.onnx" \
     "${SRC}/vector_estimator.int8.onnx" \
     "${SRC}/vocoder.int8.onnx" \
     "${SRC}/tts.json" \
     "${SRC}/unicode_indexer.bin" \
     "${SRC}/voice.bin" \
     "${TTS_DIR}/"
  # 许可证与来源说明是仓库里的小文本，会随 apk 一起打包
  rm -f /tmp/supertonic.tar.bz2
fi
for f in duration_predictor.int8.onnx text_encoder.int8.onnx vector_estimator.int8.onnx \
         vocoder.int8.onnx tts.json unicode_indexer.bin voice.bin; do
  if [ ! -s "${TTS_DIR}/${f}" ]; then
    echo "::error::神经音色模型不完整，缺少 ${f}"
    exit 1
  fi
done
echo "神经音色模型：$(du -sh "${TTS_DIR}" | cut -f1)"

echo "::group::assets 体积"
du -sh app/src/main/assets/* 2>/dev/null || true
echo "::endgroup::"

# ----------------------------------------------------------------- 编译 -----
mkdir -p dist
APK_OUT="dist/EnglishReadingCompanion-v1.5.0.apk"

if [ -n "${KEYSTORE_BASE64:-}" ] && [ -n "${KEYSTORE_PASSWORD:-}" ]; then
  echo "检测到正式签名 Secrets，编译正式签名 Release APK"
  printf '%s' "${KEYSTORE_BASE64}" | tr -d '\r\n ' | base64 -d > /tmp/release-keystore.p12
  chmod 600 /tmp/release-keystore.p12
  export RELEASE_STORE_FILE="/tmp/release-keystore.p12"
  export RELEASE_STORE_PASSWORD="${KEYSTORE_PASSWORD}"
  export RELEASE_KEY_ALIAS="${KEY_ALIAS:-release}"
  export RELEASE_KEY_PASSWORD="${KEYSTORE_PASSWORD}"

  echo "::group::gradle assembleRelease"
  "${GRADLE_BIN}" :app:assembleRelease --no-daemon --stacktrace --console=plain
  echo "::endgroup::"
  rm -f /tmp/release-keystore.p12

  APK_SRC="app/build/outputs/apk/release/app-release.apk"
else
  echo "未检测到 KEYSTORE_BASE64 / KEYSTORE_PASSWORD，回退编译 debug 签名包"
  echo "::group::gradle assembleDebug"
  "${GRADLE_BIN}" :app:assembleDebug --no-daemon --stacktrace --console=plain
  echo "::endgroup::"

  APK_SRC="app/build/outputs/apk/debug/app-debug.apk"
fi

if [ ! -f "${APK_SRC}" ]; then
  echo "::error::没有找到 ${APK_SRC}"
  find app/build/outputs -name "*.apk" || true
  exit 1
fi

cp "${APK_SRC}" "${APK_OUT}"
( cd dist && sha256sum "EnglishReadingCompanion-v1.5.0.apk" > SHA256SUMS.txt )

echo "::group::构建产物"
ls -lh dist
cat dist/SHA256SUMS.txt
echo "::endgroup::"

# ---------------------------------------------------------------- 发布 ------
if [ "${GITHUB_REF:-}" = "refs/heads/main" ]; then
  if ! command -v gh >/dev/null 2>&1; then
    echo "::error::runner 上没有 gh CLI"
    exit 1
  fi
  gh release view v1.5.0 >/dev/null 2>&1 \
    || gh release create v1.5.0 --title "英语陪读 v1.5.0" --notes-file RELEASE_NOTES.md
  gh release upload v1.5.0 "${APK_OUT}" dist/SHA256SUMS.txt --clobber
  echo "::group::Release"
  gh release view v1.5.0 --json url,assets --jq '{url: .url, assets: [.assets[].name]}'
  echo "::endgroup::"
else
  echo "非 main 分支，跳过 Release 发布"
fi

echo "完成 ✅"
