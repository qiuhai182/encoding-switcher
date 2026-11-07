@echo off
chcp 936 >nul
setlocal EnableExtensions
cd /d "%~dp0"
title encoding-switcher 提交并推送

set "EG_STATUS=%TEMP%\eg_status.txt"
set "EG_CONFLICT=%TEMP%\eg_conflict.txt"
set "EG_MSGFILE=%TEMP%\eg_commit_msg.txt"
set "EG_COMMITLOG=%TEMP%\eg_commit_log.txt"

echo ============================================
echo   encoding-switcher 本地提交并推送
echo ============================================
echo.

REM ---------- 检查 1：是否在 git 仓库 ----------
git rev-parse --is-inside-work-tree >nul 2>&1
if errorlevel 1 (
    echo [停止] 当前目录不是 git 仓库，无法提交：%~dp0
    goto :done
)

REM ---------- 检查 2：是否有未解决冲突 ----------
git ls-files -u > "%EG_CONFLICT%" 2>nul
for %%A in ("%EG_CONFLICT%") do if %%~zA GTR 0 (
    echo [停止] 存在未解决的合并冲突，请先处理冲突再上传。
    echo        查看冲突文件：git status
    goto :done
)

REM ---------- 检查 3：是否有改动 ----------
git -c core.quotepath=false status --porcelain > "%EG_STATUS%" 2>nul
for %%A in ("%EG_STATUS%") do if %%~zA EQU 0 (
    echo [跳过] 工作区没有需要提交的改动，无需上传。
    goto :done
)

echo 将要提交的改动：
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-Content -LiteralPath $env:EG_STATUS -Encoding UTF8 | ForEach-Object { Write-Host $_ }"
echo.

REM ---------- 提交信息：回车用默认，否则用输入 ----------
set "EG_MSG="
set /p "EG_MSG=请输入提交信息（直接回车用默认信息）："
if defined EG_MSG goto :msg_ready
set "EG_HMS=%TIME:~0,8%"
set "EG_HMS=%EG_HMS: =0%"
set "EG_MSG=快捷上传最新可执行文件、代码 %DATE% %EG_HMS%"
:msg_ready

REM 提交信息写 UTF-8 文件，用 -F 传入，避免中文经命令行参数被转码或截断
powershell -NoProfile -ExecutionPolicy Bypass -Command "[System.IO.File]::WriteAllText($env:EG_MSGFILE, $env:EG_MSG, (New-Object System.Text.UTF8Encoding($false)))"
if errorlevel 1 (
    echo [停止] 生成提交信息文件失败，未提交也未推送。
    goto :done
)
echo 提交信息：%EG_MSG%
echo.

REM ---------- 暂存与提交 ----------
git add -A
if errorlevel 1 (
    echo [停止] git add 失败，未提交也未推送。
    goto :done
)

git -c core.quotepath=false commit -F "%EG_MSGFILE%" > "%EG_COMMITLOG%" 2>&1
set "EG_RC=%ERRORLEVEL%"
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-Content -LiteralPath $env:EG_COMMITLOG -Encoding UTF8 | ForEach-Object { Write-Host $_ }"
if not "%EG_RC%"=="0" (
    echo [停止] 提交失败，改动仍保留在工作区，未推送。
    goto :done
)

REM ---------- 依次推送：gitee 再 github ----------
for %%R in (gitee github) do (
    call :push_one %%R
    if errorlevel 9 goto :done
)

:done
echo.
if exist "%EG_STATUS%" del "%EG_STATUS%" >nul 2>&1
if exist "%EG_CONFLICT%" del "%EG_CONFLICT%" >nul 2>&1
if exist "%EG_MSGFILE%" del "%EG_MSGFILE%" >nul 2>&1
if exist "%EG_COMMITLOG%" del "%EG_COMMITLOG%" >nul 2>&1
echo 结束。
pause
exit /b 0

:push_one
set "EG_REMOTE=%~1"
git remote get-url %EG_REMOTE% >nul 2>&1
if errorlevel 1 (
    echo [跳过] 未配置 %EG_REMOTE% 远端，跳过。
    exit /b 0
)
echo 检查 %EG_REMOTE% 远端连通性...
git ls-remote --heads %EG_REMOTE% master >nul 2>&1
if errorlevel 1 (
    echo [停止] 无法连接 %EG_REMOTE% 远端（网络或权限问题），已停止，未回滚也未强推。
    exit /b 9
)
echo 推送到 %EG_REMOTE%/master ...
git push %EG_REMOTE% HEAD:master
if errorlevel 1 (
    echo [停止] 推送到 %EG_REMOTE% 失败，本地提交已保留，未回滚也未强推。
    echo        排查后可手动重试：git push %EG_REMOTE% HEAD:master
    exit /b 9
)
echo 已推送 %EG_REMOTE%/master
exit /b 0
