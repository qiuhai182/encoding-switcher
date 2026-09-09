@echo off
chcp 65001 >nul
rem encoding-guard 构建脚本：安装依赖 -> 类型检查 -> esbuild 打包 -> 生成 vsix
cd /d "%~dp0"

if not exist node_modules (
    echo [1/4] 安装依赖...
    call npm install
    if errorlevel 1 goto fail
) else (
    echo [1/4] 依赖已安装，跳过
)

echo [2/4] 类型检查...
call npx tsc --noEmit
if errorlevel 1 goto fail

echo [3/4] 构建...
call npm run build
if errorlevel 1 goto fail

echo [4/4] 打包 vsix...
rem --skip-license: 跳过 LICENSE 警告的交互确认，避免脚本卡在 [y/N] 等待按键
call npm run package -- --skip-license
if errorlevel 1 goto fail

echo.
echo 构建完成: dist\extension.js
for %%f in (*.vsix) do echo 安装包: %%f
pause
exit /b 0

:fail
echo.
echo 构建失败，请检查上方错误信息
pause
exit /b 1
