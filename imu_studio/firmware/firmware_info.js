"use strict";

// 发布固件时只需在这里维护版本、日期和说明。
window.IMU_FIRMWARE_INFO = {
    version: "2.0",
    buildDate: "2026-08-31",
    description: "MSPM0G3507 IMU 校准与 OTA 固件"
};

window.PRESET_FIRMWARES = [
    {
        name: "IMU_G3507.bin",
        path: "firmware/IMU_G3507.bin",
        version: window.IMU_FIRMWARE_INFO.version,
        desc: `${window.IMU_FIRMWARE_INFO.description} · 构建日期 ${window.IMU_FIRMWARE_INFO.buildDate}`,
        buildDate: window.IMU_FIRMWARE_INFO.buildDate,
        dataVariable: "IMU_G3507_FIRMWARE_BASE64",
        isDefault: true
    }
];
