#!/usr/bin/env bash
# =============================================================================
# 英语陪读 —— GitHub Actions 自建构建脚本
# 在 ubuntu-latest 上从零准备好 JDK 17 / Android SDK / Gradle 8.7，
# 下载 Vosk 离线语音模型（英文 + 中文）打进 assets，
# 生成 Release APK 与校验文件，并发布到 Release v1.1.1。
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


# ------------------------------------------------------- 离线语音模型 -----
# 模型不进仓库（每个 40MB 左右），构建时下载并塞进 assets。
# 解包后必须让 am/ conf/ graph/ ivector/ 直接位于 model-en-us/、model-cn/ 之下。
MODEL_EN_DIR="app/src/main/assets/model-en-us"
MODEL_ZH_DIR="app/src/main/assets/model-cn"

fetch_model() {
  local url="$1"
  local dir="$2"
  local name="$3"
  if [ -d "${dir}/am" ] && [ -d "${dir}/conf" ]; then
    echo "离线语音模型已存在：${name}"
    return 0
  fi
  echo "下载离线语音模型：${name}"
  curl -fL --retry 3 --retry-delay 2 -o /tmp/vosk-model.zip "${url}"
  rm -rf /tmp/vosk-unpack && mkdir -p /tmp/vosk-unpack
  unzip -q -o /tmp/vosk-model.zip -d /tmp/vosk-unpack
  local src
  src="$(find /tmp/vosk-unpack -mindepth 1 -maxdepth 1 -type d | head -1)"
  if [ -z "${src}" ]; then
    echo "::error::模型 ${name} 解包失败"
    exit 1
  fi
  rm -rf "${dir}" && mkdir -p "${dir}"
  cp -R "${src}/." "${dir}/"
  rm -f /tmp/vosk-model.zip
  for sub in am conf graph; do
    if [ ! -d "${dir}/${sub}" ]; then
      echo "::error::模型 ${name} 目录不完整：缺少 ${sub}"
      exit 1
    fi
  done
  echo "模型 ${name} 就绪：$(du -sh "${dir}" | cut -f1)"
}

fetch_model "https://alphacephei.com/vosk/models/vosk-model-small-en-us-0.15.zip" "${MODEL_EN_DIR}" "英文 small-en-us-0.15"
fetch_model "https://alphacephei.com/vosk/models/vosk-model-small-cn-0.22.zip" "${MODEL_ZH_DIR}" "中文 small-cn-0.22"

echo "::group::assets 体积"
du -sh app/src/main/assets/* 2>/dev/null || true
echo "::endgroup::"

# ----------------------------------------------------------------- 编译 -----
mkdir -p dist
APK_OUT="dist/EnglishReadingCompanion-v1.1.1.apk"

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
( cd dist && sha256sum "EnglishReadingCompanion-v1.1.1.apk" > SHA256SUMS.txt )

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
  gh release view v1.1.1 >/dev/null 2>&1 \
    || gh release create v1.1.1 --title "英语陪读 v1.1.1" --notes-file RELEASE_NOTES.md
  gh release upload v1.1.1 "${APK_OUT}" dist/SHA256SUMS.txt --clobber
  echo "::group::Release"
  gh release view v1.1.1 --json url,assets --jq '{url: .url, assets: [.assets[].name]}'
  echo "::endgroup::"
else
  echo "非 main 分支，跳过 Release 发布"
fi

echo "完成 ✅"
