@echo off
setlocal EnableExtensions
chcp 65001 >nul

echo 正在打开 Windows 通知设置和 Edge 策略页...
echo.
echo 1. Windows 中检查：通知总开关、请勿打扰、横幅和通知中心。
echo 2. Edge 策略页中搜索：AllowSystemNotifications
echo    - True 或“未设置”：Edge 可以使用 Windows 系统通知。
echo    - False：Edge 会改用浏览器内部消息中心，扩展无法绕过该策略。
echo.
start "" ms-settings:notifications
start "" msedge.exe "edge://policy"
pause
