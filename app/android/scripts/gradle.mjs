// Runs the native project's Gradle wrapper with a JDK that Capacitor 8 accepts (21+).
// Keeps JAVA_HOME if it's already 21+, otherwise switches to Android Studio's bundled JBR
// (a JDK 17 JAVA_HOME fails with "invalid source release: 21").
// Usage: node scripts/gradle.mjs assembleDebug
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIN_JAVA = 21;
const JBR_CANDIDATES = [
  'C:\\Program Files\\Android\\Android Studio\\jbr',
  '/Applications/Android Studio.app/Contents/jbr/Contents/Home',
  '/opt/android-studio/jbr',
];

/** Major version from a JDK's `release` file (JAVA_VERSION="21.0.8"), or 0 if unknown. */
function javaMajor(home) {
  try {
    const m = readFileSync(join(home, 'release'), 'utf-8').match(/JAVA_VERSION="(\d+)/);
    return m ? Number(m[1]) : 0;
  } catch {
    return 0;
  }
}

const nativeDir = fileURLToPath(new URL('../native', import.meta.url));
const env = { ...process.env };
if (!env.JAVA_HOME || javaMajor(env.JAVA_HOME) < MIN_JAVA) {
  const jbr = JBR_CANDIDATES.find((p) => existsSync(p) && javaMajor(p) >= MIN_JAVA);
  if (jbr) env.JAVA_HOME = jbr;
  else console.warn(`No JDK ${MIN_JAVA}+ found; set JAVA_HOME to one (Android Studio ships one in its jbr/ folder).`);
}

const isWin = process.platform === 'win32';
// Absolute path: cmd.exe doesn't always search the working directory (NoDefaultCurrentDirectoryInExePath).
const gradlew = join(nativeDir, isWin ? 'gradlew.bat' : 'gradlew');
const result = spawnSync(isWin ? `"${gradlew}"` : gradlew, process.argv.slice(2), {
  cwd: nativeDir,
  env,
  stdio: 'inherit',
  shell: isWin,
});
process.exit(result.status ?? 1);
