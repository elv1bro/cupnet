#!/bin/bash

# Скрипт для сборки и установки CupNet в Applications

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_NAME="CupNet.app"
BUILD_DIR="$SCRIPT_DIR/dist/mac"
INSTALL_DIR="/Applications"

echo "🔨 Сборка приложения..."
cd "$SCRIPT_DIR"
npm run dist:mac

if [ ! -d "$BUILD_DIR/$APP_NAME" ]; then
    echo "❌ Ошибка: Приложение не найдено в $BUILD_DIR/$APP_NAME"
    exit 1
fi

echo "📦 Копирование приложения в Applications..."
if [ -d "$INSTALL_DIR/$APP_NAME" ]; then
    echo "⚠️  Удаление старой версии..."
    rm -rf "$INSTALL_DIR/$APP_NAME"
fi

cp -R "$BUILD_DIR/$APP_NAME" "$INSTALL_DIR/"

echo "✅ CupNet успешно установлен в $INSTALL_DIR/$APP_NAME"
echo ""
echo "🚀 Запуск приложения..."
open "$INSTALL_DIR/$APP_NAME"

