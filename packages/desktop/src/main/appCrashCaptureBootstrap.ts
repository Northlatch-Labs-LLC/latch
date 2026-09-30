import { logger } from "./logger.js";
import { initializeCrashCapture, type CrashCapturePaths } from "./desktopCrashCapture.js";

// 须在其余主进程模块之前完成：先由 desktopEarlyDataBaseDirBootstrap 注入 dataBaseDir，再配置 crashDumps。
// remoteCrashReporterEnabled=true 表示远端 crash 上报由原 ARMS 链路接管（该 SDK 已随 Latch productization 移除），
// 本地仅保留 crash 留档与清理。
export const crashCapturePaths: CrashCapturePaths = initializeCrashCapture(logger, true);
