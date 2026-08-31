# Embedded Studio

Embedded Studio 是一套面向嵌入式开发的纯前端 Web 上位机工具集，使用浏览器原生 Web Serial API 连接硬件，支持串口监控、波形分析、电机控制、IMU 姿态监控和固件升级。

## 功能模块

### FOC Studio

MSPM0G3507 无刷电机控制台，提供实时遥测、波形显示、电流/速度/位置控制、LADRC 参数调节，以及 FOC 固件串口 OTA 升级。支持普通速度、低速大力矩、梯形步进和直接位置阶跃模式。

### IMU Studio

MSPM0G3507 IMU 姿态监控和升级工具，提供 Roll / Pitch / Yaw 三维姿态显示、传感器与数据格式选择、六面校准流程和 IMU 固件 OTA 升级。

### Universal Plotter

通用串口示波器，支持 VOFA+ FireWater、JustFloat 协议，最高 16 通道波形显示、游标测量、缩放拖拽、CSV 导出和串口调试终端。

### H7RS Flasher

STM32 H7RS 屏幕资源烧录工具，支持图片、视频抽帧、动画帧管理、屏幕布局预览和 USB-CDC 串口烧录。

## 快速开始

建议使用桌面版 Google Chrome 或 Microsoft Edge，并通过本地 HTTP 服务运行：

```powershell
python -m http.server 8080
```

然后打开 <http://localhost:8080>。也可以使用 VS Code Live Server 等静态服务器。

连接硬件前，请确认 USB 串口没有被其他软件占用。进行 OTA 或烧录时，应停止普通遥测和控制命令发送。

## FOC 控制指令

FOC 页面使用固定 6 字节控制帧，主要运动指令如下：

| 指令 | 作用 | 量程 |
| --- | --- | --- |
| `0x04` | Iq 目标电流 | 界面限制 ±1.5 A |
| `0x05` | 普通目标速度 | ±100 Hz |
| `0x06` | 低速大力矩速度 | ±2 Hz |
| `0x07` | 绝对位置 | ±10 圈 |
| `0x08` | 梯形相对步进 | ±2 圈 |
| `0x70` | 无梯形位置阶跃，仅串口 | ±2 圈 |

## 固件 OTA

FOC 和 IMU 固件分别位于：

```text
foc_studio/firmware/
imu_studio/firmware/
```

更新固件时替换对应的同名 `.bin` 文件，并同步修改同目录的 `firmware_info.js`。如果页面使用内嵌的 `firmware_data.js`，还需要重新生成其中的 Base64 数据。

## 浏览器支持

| 浏览器 | 支持情况 |
| --- | --- |
| Chrome 89+ | 支持 |
| Edge 89+ | 支持 |
| Firefox | 不支持 Web Serial |
| Safari | 不支持 Web Serial |

## 目录结构

```text
Platform/
├── index.html
├── foc_studio/        # FOC 电机控制与 OTA
├── imu_studio/        # IMU 姿态监控与 OTA
├── serial_plotter/    # 通用串口示波器
└── h7rs_flasher/      # H7RS 屏幕资源烧录
```

## 许可证

本项目基于 [MIT License](LICENSE) 发布。
