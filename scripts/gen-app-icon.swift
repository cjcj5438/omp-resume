#!/usr/bin/env swift
// 生成 omp-resume 应用图标母版 src-tauri/icons/app-icon.png（1024×1024 RGBA，透明底）。
// 用法（仓库根目录）：swift scripts/gen-app-icon.swift [输出路径]
// 之后：npx tauri icon src-tauri/icons/app-icon.png 生成各平台尺寸。
//
// 设计：824×824 超椭圆瓦片（n=5，近似 macOS 连续转角），紫→靛竖向渐变，顶部极淡高光；
// 白色 π 与托盘图标 src-tauri/icons/tray-icon.png 同比例（44px 网格实测：顶杆 26×6，
// 腿宽 6，腿间距 11，顶杆两端外伸约 1.5px，总高 22），π 外宽 = 瓦片宽 50%。
// 渲染：CoreGraphics 原生抗锯齿（无需超采样）；无随机性，输出可复现。
// 只用系统自带的 CoreGraphics / ImageIO，无第三方依赖。

import CoreGraphics
import Foundation
import ImageIO

let canvas: CGFloat = 1024
let center = canvas / 2
let tileSize: CGFloat = 824                       // 四周各留 100px，内含投影
let tileTop = (canvas - tileSize) / 2
let tileBottom = tileTop + tileSize

// 设计坐标：原点左上、y 向下；CoreGraphics 原点在左下，经 pt() 换算。
func pt(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: x, y: canvas - y) }

func rgb(_ hex: UInt32, alpha: CGFloat = 1) -> CGColor {
    CGColor(srgbRed: CGFloat((hex >> 16) & 0xFF) / 255,
            green: CGFloat((hex >> 8) & 0xFF) / 255,
            blue: CGFloat(hex & 0xFF) / 255,
            alpha: alpha)
}

// 超椭圆 |x/a|^n + |y/b|^n = 1 的参数化采样（多边形逼近，1440 段对 1024px 足够平滑）
func superellipse(center c: CGPoint, a: CGFloat, b: CGFloat, n: Double, steps: Int) -> CGPath {
    func signedPow(_ v: Double, _ e: Double) -> Double { (v < 0 ? -1 : 1) * pow(abs(v), e) }
    let path = CGMutablePath()
    for i in 0..<steps {
        let t = Double(i) / Double(steps) * 2 * Double.pi
        let p = CGPoint(x: c.x + a * CGFloat(signedPow(cos(t), 2 / n)),
                        y: c.y + b * CGFloat(signedPow(sin(t), 2 / n)))
        if i == 0 { path.move(to: p) } else { path.addLine(to: p) }
    }
    path.closeSubpath()
    return path
}

// π 几何：以顶杆外宽 W 为基准，比例取自托盘图标（宽 26px、高 22px、顶杆/腿厚 6px）。
let glyphW = tileSize * 0.50
let stroke = glyphW * 6 / 26                      // 顶杆厚 = 腿宽
let overhang = glyphW * 1.5 / 26                  // 顶杆两端相对腿外缘的伸出量
let glyphH = glyphW * 22 / 26

// 位置：包围盒几何居中后上移 1% 瓦片高（≈8px，略高于几何中心，光学上更稳）。
// 曾试过包围盒中心与质心的中点对齐：π 顶重，字形会整体下压约 15px，偏低，故弃用。
let x0 = center - glyphW / 2, x1 = center + glyphW / 2
let y0 = center - glyphH / 2 - tileSize * 0.01, y1 = y0 + stroke, y2 = y0 + glyphH

let piPath = CGMutablePath()
let piOutline = [
    pt(x0, y0), pt(x1, y0), pt(x1, y1),                                   // 顶杆（右端外伸）
    pt(x1 - overhang, y1), pt(x1 - overhang, y2),                         // 右腿外缘
    pt(x1 - overhang - stroke, y2), pt(x1 - overhang - stroke, y1),       // 右腿内缘
    pt(x0 + overhang + stroke, y1), pt(x0 + overhang + stroke, y2),       // 左腿内缘
    pt(x0 + overhang, y2), pt(x0 + overhang, y1),                         // 左腿外缘
    pt(x0, y1),                                                           // 顶杆（左端外伸）
]
piPath.addLines(between: piOutline)
piPath.closeSubpath()

let tilePath = superellipse(center: CGPoint(x: center, y: center),
                            a: tileSize / 2, b: tileSize / 2, n: 5, steps: 1440)

let cs = CGColorSpace(name: CGColorSpace.sRGB)!
guard let ctx = CGContext(data: nil, width: Int(canvas), height: Int(canvas),
                          bitsPerComponent: 8, bytesPerRow: 0, space: cs,
                          bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else {
    fatalError("无法创建 CGContext")
}

let violet = rgb(0x7C3AED)   // 顶
let indigo = rgb(0x4338CA)   // 底
let fillGradient = CGGradient(colorsSpace: cs, colors: [violet, indigo] as CFArray, locations: [0, 1])!
let sheenGradient = CGGradient(colorsSpace: cs,
                               colors: [rgb(0xFFFFFF, alpha: 0.08), rgb(0xFFFFFF, alpha: 0)] as CFArray,
                               locations: [0, 1])!

// 1) 瓦片投影：只在瓦片外露出的部分可见
ctx.saveGState()
ctx.setShadow(offset: CGSize(width: 0, height: -12), blur: 30, color: rgb(0x000000, alpha: 0.30))
ctx.addPath(tilePath)
ctx.setFillColor(violet)
ctx.fillPath()
ctx.restoreGState()

// 2) 瓦片渐变 + 顶部高光 + 白色 π（柔和投影）
ctx.saveGState()
ctx.addPath(tilePath)
ctx.clip()
ctx.drawLinearGradient(fillGradient, start: pt(center, tileTop), end: pt(center, tileBottom), options: [])
ctx.drawLinearGradient(sheenGradient, start: pt(center, tileTop),
                       end: pt(center, tileTop + tileSize / 2), options: [])
ctx.setShadow(offset: CGSize(width: 0, height: -10), blur: 22, color: rgb(0x000000, alpha: 0.25))
ctx.addPath(piPath)
ctx.setFillColor(rgb(0xFFFFFF))
ctx.fillPath()
ctx.restoreGState()

// 输出：默认写到 src-tauri/icons/app-icon.png（相对脚本自身定位仓库根目录）
let repoRoot = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
let defaultOut = repoRoot.appendingPathComponent("src-tauri/icons/app-icon.png").path
let outURL = URL(fileURLWithPath: CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : defaultOut)

guard let image = ctx.makeImage(),
      let dest = CGImageDestinationCreateWithURL(outURL as CFURL, "public.png" as CFString, 1, nil) else {
    fatalError("无法创建输出：\(outURL.path)")
}
CGImageDestinationAddImage(dest, image, nil)
guard CGImageDestinationFinalize(dest) else { fatalError("写入失败：\(outURL.path)") }
print("已写入 \(outURL.path)（\(image.width)×\(image.height)）")
