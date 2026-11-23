#!/usr/bin/env bash
# =============================================================================
# 英语陪读 —— GitHub Actions 自建构建脚本
# 在 ubuntu-latest 上从零准备好 JDK 17 / Android SDK / Gradle 8.7，
# 编译 debug APK，生成校验文件，并发布到 Release v1.0.0。
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

# ----------------------------------------------------------------- 编译 -----
echo "::group::gradle assembleDebug"
"${GRADLE_BIN}" :app:assembleDebug --no-daemon --stacktrace --console=plain
echo "::endgroup::"

mkdir -p dist
APK_SRC="app/build/outputs/apk/debug/app-debug.apk"
APK_OUT="dist/EnglishReadingCompanion-v1.0.0.apk"

if [ ! -f "${APK_SRC}" ]; then
  echo "::error::没有找到 ${APK_SRC}"
  find app/build/outputs -name "*.apk" || true
  exit 1
fi

cp "${APK_SRC}" "${APK_OUT}"
( cd dist && sha256sum "EnglishReadingCompanion-v1.0.0.apk" > SHA256SUMS.txt )

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
  gh release view v1.0.0 >/dev/null 2>&1 \
    || gh release create v1.0.0 --title "英语陪读 v1.0.0" --notes-file RELEASE_NOTES.md
  gh release upload v1.0.0 "${APK_OUT}" dist/SHA256SUMS.txt --clobber
  echo "::group::Release"
  gh release view v1.0.0 --json url,assets --jq '{url: .url, assets: [.assets[].name]}'
  echo "::endgroup::"
else
  echo "非 main 分支，跳过 Release 发布"
fi

echo "完成 ✅"
