@echo off
cd /d "%~dp0"
echo [ffmpeg-bridge] 正在启动本地 FFmpeg 桥接服务...
node "%~dp0ffmpeg-bridge.js"
echo.
echo 服务已退出。按任意键关闭窗口。
pause >nul