#!/usr/bin/env bash
# 在当前目录启动静态资源代理（开发服务器），默认端口 8000
cd "$(dirname "$0")"
echo "在目录内启动代理: $(pwd)"
echo "访问地址: http://localhost:8000"
echo "按 Ctrl+C 停止"
npx serve . -p 8000
