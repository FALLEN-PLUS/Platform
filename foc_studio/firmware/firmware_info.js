"use strict";

window.PRESET_FIRMWARES = [
    {
        name: "FOC G3507 音乐版",
        fileName: "FOC_G3507_MUSIC.bin",
        path: "firmware/FOC_G3507_MUSIC.bin",
        version: "2.6.4",
        desc: "音乐版固件：包含在线电机音乐、音频会话隔离、安全互锁及串口/CAN 断联保护。",
        dataVariable: "FOC_G3507_MUSIC_FIRMWARE_BASE64",
        isDefault: true
    },
    {
        name: "FOC G3507 标准版",
        fileName: "FOC_G3507_STANDARD.bin",
        path: "firmware/FOC_G3507_STANDARD.bin",
        version: "2.4",
        desc: "标准版固件：保留原有电机控制功能，不包含在线音乐功能。",
        dataVariable: "FOC_G3507_STANDARD_FIRMWARE_BASE64",
        isDefault: false
    }
];
