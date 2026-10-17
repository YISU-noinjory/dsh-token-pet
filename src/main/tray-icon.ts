/**
 * 托盘图标资源。
 *
 * ## 为什么内嵌 base64 而不是放一个 .png 文件
 *
 * 主进程由 `tsc` 编译到 `dist/main`，资源文件需要额外一步拷贝，还要处理
 * 「开发时相对源码目录、打包后相对 dist 目录」的路径差异。而托盘只需要一张
 * 32×32 的小图（约 1.4KB），内嵌之后产物自洽，直接消掉"图片没被复制过去"
 * 这一整类失败模式。
 *
 * 图片是脚本用 System.Drawing 生成的 32×32 PNG：与内置宠物同色系的
 * 蓝色渐变软糖造型，带顶部高光和两只眼睛，缩到 16×16 仍能认出是宠物。
 */

import { nativeImage, type NativeImage } from 'electron'

/** 32×32 PNG 的 base64 内容。 */
const TRAY_ICON_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAUtSURBVFhH7dZbTFN3HAdwH3300cdlyxaSmQW3F5NtAXYLAxlFQCoXAUHHTQVFaOnllEuBqVBAFKVApVBaUENMZjTOC9Nke9gDD1scpUDH/U4LvZyzp+9y/m1Pz6Wiy3zYkv2S/1tzPv/f73d+v9M9e/6P/2JQo9hHWelYFf8M0LGVJu9+8W/fWBB0mC7S2pj7GhsDtZWGaog9ftRYfFAO+qAY8KLa7Pm5yrRd/sYuQ5mwl7Ix5Vob49LaGGisdBAXw15U9Xtw4eYOKk07ONfrpit6XbqzJtc+8TNfO6jbTJTWxoxrhxlobHzY/1L4fN82i6Oix43yHhfOdruWT3dvHBI/+5VBDdPxGhvjEsONd/zQ3/ah4ZYPygEPhxO4bxsVvUHY6MKZ7i2cvrGJsq5NuqxrI09svDSokT+j1TbGFeqzxupH+z0almcMbM8ZWJ/TGHpGY3DMjyvfe1F1M5x1GN7C6essvoHSaxsoubqOks7VeLElCWrEu19t8ztDWauHfDD+EIIZArPH8mPgAoNjPnQ/8OJ8L5v1Fi/rMFzcuY6izjV827FGn+pYjBKbglBbaQO/z2y5WVwK+zEw5oP5qQ/mJz7UWt0B+PomSgm+TnACX1nDqY41nGxfRWHb6qjY5KLaSr+ltPho/tvdfMfLw6Vw/xMv+h97UGdzS7O+QrLGqfZVghe0reCEYRm5hoVosU1CafHpePNMXjCFeQfmpwGYLfeAAPai/5EHfQ93cL5nUwiTrANwYdsKCgwrONG6jPyWJeS1LJnENonqAe/vkcZKNbgN40Mvgc0sHMz65iMPjA92oDRthvscCTYsI7+VwMi9vIici4uuXMq5V4Czm4vNWjjPwrHSWtxouuVG44gb+mEXqMGtYNZrJGten7ly57cuc/DxSyy+gJzv5pHVPC/cDdUmT2wA3ya4dJ6lYyXoMy9rIbyE3EuLOE7gBWQ3zyOraQ6ZDbPCvVBp2s4TbDEju8W2cGY3OFK5w32ODDfO4VjjLDL0szrBBcp73EXc+uRvseBYlVxbR/HVdWTUjOGockwKB7NOqXwMWeUjrtzZgXIjsykAy/WzyGj4A+n1TuEFKoyb8ZHg0DyzfY452oh3DsSR89FXpZI+f5xaj7cPxJFz8PNiYdZBmD1H651Ir50qElyg7MZ61G59zqR+4fDQkZ17wPU5TfkTh4dOYtk9Asv1PLjOibTaGaRQDulaLuvaWJasz2CfE4oskgt8ltMZeLsvLuDLArPkAp/K2yVwWu00juim6GTKKf1Ml1zb6Iq8PleQXH5PgLPAF/l9XJ8TSu+G8fcDJybbSOD0OhaeQapuGkeoKci0U/fFNomi9pVD/PVZyF+fl+YQHXeSQ977MBFy3W9cn4/VT+ODmEIOf/dgIlJqxgVwinYKMo0DyeoJmdjm4mT76qh4rNg+511eQpbegbisDsRmdSCD+lUwVmyf07Qv8ElGGzky5XgQnubBDiSpJsfFpiAKDavRBYYVmswzb32SseLmWTpW4j7zs2bhb1STSKqZRIJiQvryiSO3ZUEeaX1y5RbAIVzY53DWk0HcjkSlXTj7u0XOxXlFxC3GjhV/ngWwsNyhrA8r7UhUTEb+Au4W2c1z8symOVe4z9JyvxJW2hGvmCgXP/u145jeGSVvmB3lwy8rN4FVkzgcKDfb76fxVS/+/j/iSJFR74xNr52xptZO02KY32c26wSFffTrC7uM2j+NZLVDlqxx6JJVDl2Syq5LUtp17AuWWGWXx4j/aPzb4y+qEc8NLEZlrgAAAABJRU5ErkJggg=='

/**
 * 构造托盘图标。
 *
 * @returns 可直接交给 `new Tray(...)` 的原生图像。
 */
export function createTrayIcon(): NativeImage {
  return nativeImage.createFromBuffer(Buffer.from(TRAY_ICON_PNG_BASE64, 'base64'))
}
