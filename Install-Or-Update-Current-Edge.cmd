@echo off
setlocal EnableExtensions
chcp 65001 >nul

set "SOURCE=%~dp0extension"
set "LEGACY_TARGET=%LOCALAPPDATA%\GPTReplyNotifier\extension"
set "NEW_TARGET=%LOCALAPPDATA%\TurnBell\extension"
set "TARGET=%NEW_TARGET%"

rem Keep an already-loaded unpacked extension at the same path so Edge retains
rem its extension ID and the user does not accidentally install a duplicate.
if exist "%LEGACY_TARGET%\manifest.json" set "TARGET=%LEGACY_TARGET%"

if not exist "%SOURCE%\manifest.json" (
  echo [错误] 未找到 extension\manifest.json。
  echo 请先完整解压发布包，不要直接在 ZIP 预览窗口中运行。
  pause
  exit /b 1
)

if not exist "%TARGET%" mkdir "%TARGET%"

robocopy "%SOURCE%" "%TARGET%" /MIR /R:2 /W:1 /NFL /NDL /NJH /NJS /NP >nul
set "RC=%ERRORLEVEL%"
if %RC% GEQ 8 (
  echo [错误] 扩展文件复制失败，Robocopy 返回码：%RC%
  pause
  exit /b %RC%
)

echo.
echo TurnBell 1.5.0 已复制到：
echo %TARGET%
echo.
echo 已安装旧版：请在扩展卡片上点击“重新加载”。
echo 更新完成后，请刷新所有已经打开的 ChatGPT 标签页。
echo 首次安装：开启开发人员模式，点击“加载解压缩的扩展”，选择上面的目录。
echo 请确认 edge://extensions/ 中最终只保留一个 TurnBell，避免重复提醒。
echo.

start "" explorer.exe "%TARGET%"
start "" msedge.exe "edge://extensions/"

pause
exit /b 0
