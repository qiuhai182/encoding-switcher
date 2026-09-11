#!/bin/bash

git pull github master
git pull gitee master
python convert_to_utf8.py
git add --all -- ':!nul'
git commit -m "快捷上传最新可执行文件、代码"
git push github
git push gitee
