#!/usr/bin/env bash
set -e
git remote set-url origin https://github.com/momenrezk783-cpu/mizan-voice-gateway-agents-sdk-v2.git 2>/dev/null || git remote add origin https://github.com/momenrezk783-cpu/mizan-voice-gateway-agents-sdk-v2.git
git branch -M main
git push -u origin main --force
echo "✅ Pushed successfully to https://github.com/momenrezk783-cpu/mizan-voice-gateway-agents-sdk-v2.git"
