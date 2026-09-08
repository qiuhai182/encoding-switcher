#!/bin/bash

git pull
git pull
git add --all -- ':!nul'
git commit -m "快捷上传最新可执行文件、代码"
git push
