"use strict";

// 每次发布固件时只需要修改这里的版本、日期和说明。
window.FOC_FIRMWARE_INFO = {
    version: "2.5.0",
    buildDate: "2026-08-31",
    description: "MSPM0G3507 FOC 正式固件（含 0x06 低速大力矩与 0x70 直接位置阶跃）"
};

window.PRESET_FIRMWARES = [
    {
        name: "FOC_G3507.bin",
        path: "firmware/FOC_G3507.bin",
        version: window.FOC_FIRMWARE_INFO.version,
        desc: window.FOC_FIRMWARE_INFO.description,
        dataVariable: "FOC_G3507_FIRMWARE_BASE64",
        isDefault: true
    }
];
