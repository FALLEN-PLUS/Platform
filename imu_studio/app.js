"use strict";

/**
 * IMU Motion Studio · 工业级高颜值旗舰主控制器
 * 深度适配 MSPM0G3507 · 预置固件库 / 本地双模 OTA · 通道自动识别与自由映射
 */

// 实例化单例通信引擎与 OTA 升级系统
const serialHub = new ImuUnifiedSerialHub();
const otaEngine = new ImuOtaEngine(serialHub);
window.imuOtaEngine = otaEngine;

const CAL_Q30 = 1073741824;
const calibrationState = {
    busy: false,
    phase: "idle",
    xvCurrent: 1034786471,
    icmCurrent: 1066912826,
    xvDefault: 1034786471,
    icmDefault: 1066912826,
    zResult: null,
    accResult: null
};

// 3D 姿态正方体渲染器
let cubeRenderer = null;
try
{
    const canvas = document.getElementById("imuCanvas");
    if (canvas && window.ImuCubeRenderer)
    {
        cubeRenderer = new window.ImuCubeRenderer(canvas);
    }
}
catch (e)
{
    console.warn("3D 渲染器初始化:", e.message);
}

// 辅助 DOM 函数
function el(id) { return document.getElementById(id); }

const MONITOR_CONFIG_KEY = "imu_studio_monitor_config_v1";

function saveMonitorConfig()
{
    const config = {
        device: el("selectDev")?.value || "XV",
        format: el("selectFmt")?.value || "JF",
        dataType: el("selectDataType")?.value || "EULER",
        frequency: el("selectFreq")?.value || "100",
        mapRoll: el("mapRoll")?.value || "0",
        mapPitch: el("mapPitch")?.value || "1",
        mapYaw: el("mapYaw")?.value || "2"
    };
    localStorage.setItem(MONITOR_CONFIG_KEY, JSON.stringify(config));
}

function loadMonitorConfig()
{
    let config = null;
    try
    {
        config = JSON.parse(localStorage.getItem(MONITOR_CONFIG_KEY) || "null");
    }
    catch (_error)
    {
        config = null;
    }

    const defaults = config || {
        device: "XV", format: "JF", dataType: "EULER", frequency: "100",
        mapRoll: "0", mapPitch: "1", mapYaw: "2"
    };
    const fields = {
        selectDev: defaults.device,
        selectFmt: defaults.format,
        selectDataType: defaults.dataType,
        selectFreq: defaults.frequency,
        mapRoll: defaults.mapRoll,
        mapPitch: defaults.mapPitch,
        mapYaw: defaults.mapYaw
    };
    Object.entries(fields).forEach(([id, value]) =>
    {
        const field = el(id);
        if (field && Array.from(field.options).some(option => option.value === String(value)))
        {
            field.value = String(value);
        }
    });
}

function showToast(msg, type = "info")
{
    const container = el("toastContainer");
    if (!container) { return; }
    const t = document.createElement("div");
    t.className = `toast ${type}`;
    t.textContent = msg;
    container.appendChild(t);
    setTimeout(() => t.remove(), 3200);
}

function addTerminalLog(msg, type = "info")
{
    const box = el("terminalOutputBox");
    if (!box) { return; }
    const line = document.createElement("div");
    line.className = `log-line ${type}`;
    const timeStr = new Date().toLocaleTimeString("zh-CN", { hour12: false });
    line.textContent = `[${timeStr}] ${msg}`;
    box.appendChild(line);
    while (box.children.length > 500)
    {
        box.firstElementChild.remove();
    }
    if (el("chkRawAutoScroll")?.checked)
    {
        box.scrollTop = box.scrollHeight;
    }
}

function addOtaConsoleLog(msg, type = "info")
{
    const box = el("otaLogConsole");
    if (!box) { return; }
    const line = document.createElement("div");
    line.className = `log-line ${type}`;
    const timeStr = new Date().toLocaleTimeString("zh-CN", { hour12: false });
    line.textContent = `[${timeStr}] ${msg}`;
    box.appendChild(line);
    while (box.children.length > 600)
    {
        box.firstElementChild.remove();
    }
    box.scrollTop = box.scrollHeight;
}

// =============================================================================
// 1. 串口状态机与连接管理
// =============================================================================
function updateOtaStartButton()
{
    const button = el("btnStartOta");
    if (!button) { return; }

    // Why: 未连接串口时仍允许点击，以便给出明确提示；只有当前确实不能启动 OTA 时才禁用。
    button.disabled = !otaEngine.firmwareData || calibrationState.busy || otaEngine.isBusy;
    document.querySelector(".ota-card")?.classList.toggle("ota-busy", otaEngine.isBusy);
}

function updateSerialStateUi(state)
{
    const dot = el("serialStateDot");
    const txt = el("serialStateText");
    const btnLabel = el("btnConnectLabel");

    const connected = serialHub.isConnected;

    if (dot)
    {
        dot.className = "status-dot";
        if (state === SerialState.DISCONNECTED) { dot.classList.add("disconnected"); }
        else if (state === SerialState.PORT_OPEN) { dot.classList.add("port_open"); }
        else if (state === SerialState.RECEIVING) { dot.classList.add("receiving"); }
        else if (state === SerialState.BOOTLOADER) { dot.classList.add("bootloader"); }
        else if (state === SerialState.OTA_WRITING) { dot.classList.add("ota_writing"); }
        else if (state === SerialState.ERROR) { dot.classList.add("error"); }
    }

    if (txt)
    {
        if (state === SerialState.DISCONNECTED) { txt.textContent = "串口未打开"; }
        else if (state === SerialState.PORT_OPEN) { txt.textContent = "串口已打开 (待机)"; }
        else if (state === SerialState.RECEIVING) { txt.textContent = "正在接收数据 (在线)"; }
        else if (state === SerialState.BOOTLOADER) { txt.textContent = "Bootloader 模式"; }
        else if (state === SerialState.OTA_WRITING) { txt.textContent = "OTA 升级中..."; }
        else if (state === SerialState.ERROR) { txt.textContent = "串口异常 / 断开"; }
    }

    if (btnLabel)
    {
        btnLabel.textContent = connected ? "断开串口" : "连接串口";
    }

    const connectBtn = el("btnConnect");
    if (connectBtn)
    {
        connectBtn.className = connected ? "btn-connect-ready connected" : "btn-connect-ready";
    }

    document.querySelectorAll(".requires-connection").forEach(b =>
    {
        b.disabled = !connected;
    });

    updateOtaStartButton();
    updateCalibrationButtons();
}

function openOtaModal()
{
    if (calibrationState.busy)
    {
        showToast("校准中，不能执行OTA", "warning");
        return;
    }
    el("otaModal").style.display = "flex";
    updateOtaStartButton();
}

function formatQ30(value)
{
    return Number.isFinite(value) ? (value / CAL_Q30).toFixed(6) : "--";
}

function setCalibrationRail(kind, activeIndex)
{
    const rail = document.querySelector(`[data-cal-rail="${kind}"]`);
    if (!rail) { return; }
    rail.querySelectorAll(".rail-step").forEach((step, index) =>
    {
        step.classList.toggle("active", index === activeIndex);
        step.classList.toggle("done", index < activeIndex);
    });
}

function updateCalibrationReference()
{
    if (el("calZXvCurrent")) { el("calZXvCurrent").textContent = formatQ30(calibrationState.xvCurrent); }
    if (el("calZIcmCurrent")) { el("calZIcmCurrent").textContent = formatQ30(calibrationState.icmCurrent); }
    if (el("calZXvDefault")) { el("calZXvDefault").textContent = formatQ30(calibrationState.xvDefault); }
    if (el("calZIcmDefault")) { el("calZIcmDefault").textContent = formatQ30(calibrationState.icmDefault); }
}

function updateCalibrationButtons()
{
    const connected = serialHub.isConnected;
    const otaBusy = otaEngine.isBusy;
    const phase = calibrationState.phase;
    const setDisabled = (id, disabled) => { if (el(id)) { el(id).disabled = disabled; } };

    setDisabled("btnCalRead", !connected || calibrationState.busy || otaBusy);
    setDisabled("btnCalZStart", !connected || calibrationState.busy || otaBusy);
    setDisabled("btnCalZFinish", !connected || phase !== "zRunning");
    setDisabled("btnCalZSave", !connected || phase !== "zResult");
    setDisabled("btnCalZDefault", !connected || calibrationState.busy || otaBusy);
    setDisabled("btnCalCancel", !connected || !calibrationState.busy);
    setDisabled("btnCalAccStart", !connected || calibrationState.busy || otaBusy);
    setDisabled("btnCalAccSave", !connected || phase !== "accResult");
    setDisabled("btnCalAccDefault", !connected || calibrationState.busy || otaBusy);
    setDisabled("btnCalAccCancel", !connected || !calibrationState.busy);

    ["btnStartMonitoring", "btnApplyConfig", "btnStopMonitoring", "btnTriggerSim"].forEach(id =>
    {
        if (el(id)) { el(id).disabled = calibrationState.busy || (id !== "btnTriggerSim" && !connected); }
    });
    if (el("btnOpenOtaModal")) { el("btnOpenOtaModal").disabled = calibrationState.busy; }
}

function setCalibrationBusy(phase)
{
    calibrationState.phase = phase;
    calibrationState.busy = phase !== "idle";
    updateCalibrationButtons();
}

function resetFaceGrid()
{
    document.querySelectorAll(".calibration-face").forEach(face =>
    {
        face.classList.remove("done", "current", "invalid");
    });
    if (el("calAccProgress")) { el("calAccProgress").style.width = "0%"; }
}

async function sendCalibrationCommand(command)
{
    if (!serialHub.isConnected)
    {
        showToast("串口未连接", "error");
        return;
    }
    await serialHub.sendText(`${command}\r\n`);
}

function handleCalibrationLine(line)
{
    const parts = line.split(",");
    if ((parts.length < 2) || (parts[0] !== "@CAL")) { return; }

    if (parts[1] === "READ" && parts.length >= 12)
    {
        calibrationState.xvCurrent = Number(parts[2]);
        calibrationState.icmCurrent = Number(parts[3]);
        calibrationState.xvDefault = Number(parts[10]);
        calibrationState.icmDefault = Number(parts[11]);
        updateCalibrationReference();
        return;
    }

    if (parts[1] === "Z" && parts[2] === "START")
    {
        setCalibrationBusy("zRunning");
        setCalibrationRail("z", 1);
        el("calZStatus").textContent = "校准中";
        el("calZXvTurns").textContent = parts[3] === "1" ? "0.000 圈" : "未安装";
        el("calZIcmTurns").textContent = parts[4] === "1" ? "0.000 圈" : "未安装";
        el("calZProgress").style.width = "0%";
        el("calZResult").textContent = "校准结果：--";
        return;
    }
    if (parts[1] === "Z" && parts[2] === "RUN")
    {
        const xvMilli = Number(parts[3]);
        const icmMilli = Number(parts[4]);
        if (xvMilli >= 0) { el("calZXvTurns").textContent = `${(xvMilli / 1000).toFixed(3)} 圈`; }
        if (icmMilli >= 0) { el("calZIcmTurns").textContent = `${(icmMilli / 1000).toFixed(3)} 圈`; }
        const progressTurns = Math.max(xvMilli, icmMilli, 0) / 1000;
        el("calZProgress").style.width = `${Math.min(100, progressTurns * 10)}%`;
        if (progressTurns >= 10) { el("calZStatus").textContent = "校准结束"; }
        return;
    }
    if (parts[1] === "Z" && parts[2] === "RESULT")
    {
        const xvAvailable = parts[5] === "1";
        const icmAvailable = parts[6] === "1";
        calibrationState.zResult = {
            xv: Number(parts[3]), icm: Number(parts[4]), xvAvailable, icmAvailable
        };
        setCalibrationBusy("zResult");
        setCalibrationRail("z", 2);
        el("calZStatus").textContent = "校准结束";
        const xvText = xvAvailable ? `XV ${formatQ30(calibrationState.zResult.xv)}` : "XV 未安装";
        const icmText = icmAvailable ? `ICM ${formatQ30(calibrationState.zResult.icm)}` : "ICM 未安装";
        el("calZResult").textContent = `校准结果：${xvText}，${icmText}`;
        return;
    }

    if (parts[1] === "ACC" && parts[2] === "START")
    {
        setCalibrationBusy("accRunning");
        setCalibrationRail("acc", 1);
        el("calAccStatus").textContent = "校准中";
        el("calAccResult").textContent = "校准结果：--";
        resetFaceGrid();
        return;
    }
    if (parts[1] === "ACC" && parts[2] === "RUN")
    {
        const mask = Number(parts[3]);
        const currentFace = Number(parts[4]);
        const faceProgress = Number(parts[5]);
        const status = Number(parts[6]);
        document.querySelectorAll(".calibration-face").forEach(face =>
        {
            const index = Number(face.dataset.face);
            face.classList.toggle("done", (mask & (1 << index)) !== 0);
            face.classList.toggle("current", index === currentFace && status === 1);
            face.classList.toggle("invalid", index === currentFace && status === 2);
        });
        const completed = [0, 1, 2, 3, 4, 5].filter(i => (mask & (1 << i)) !== 0).length;
        el("calAccProgress").style.width = `${Math.min(100, (completed + faceProgress / 100) * 100 / 6)}%`;
        if (status === 1) { el("calAccStatus").textContent = "校准中"; }
        else if (status === 2) { el("calAccStatus").textContent = "检测到移动，重新采集"; }
        else if (status === 3) { el("calAccStatus").textContent = "当前面完成，请换面"; }
        else { el("calAccStatus").textContent = "请放置板子"; }
        return;
    }
    if (parts[1] === "ACC" && parts[2] === "RESULT")
    {
        calibrationState.accResult = parts.slice(3, 9).map(Number);
        setCalibrationBusy("accResult");
        setCalibrationRail("acc", 2);
        el("calAccStatus").textContent = "校准结束";
        el("calAccProgress").style.width = "100%";
        el("calAccResult").textContent = `校准结果：Bias ${calibrationState.accResult.slice(0, 3).join(" / ")}，Scale ${calibrationState.accResult.slice(3).map(formatQ30).join(" / ")}`;
        return;
    }

    if (parts[1] === "SAVED")
    {
        if (parts[2] === "Z" && calibrationState.zResult)
        {
            if (calibrationState.zResult.xvAvailable) { calibrationState.xvCurrent = calibrationState.zResult.xv; }
            if (calibrationState.zResult.icmAvailable) { calibrationState.icmCurrent = calibrationState.zResult.icm; }
            updateCalibrationReference();
            el("calZStatus").textContent = "保存完成";
        }
        else if (parts[2] === "ACC")
        {
            el("calAccStatus").textContent = "保存完成";
        }
        setCalibrationBusy("idle");
        showToast("校准参数已保存", "success");
        return;
    }
    if (parts[1] === "DEFAULT")
    {
        setCalibrationBusy("idle");
        if (parts[2] === "Z") { el("calZStatus").textContent = "已恢复默认"; }
        else { el("calAccStatus").textContent = "已恢复默认"; }
        sendCalibrationCommand("CAL/READ").catch(() => {});
        showToast("已恢复默认参数", "success");
        return;
    }
    if (parts[1] === "CANCELLED")
    {
        setCalibrationBusy("idle");
        setCalibrationRail("z", 0);
        setCalibrationRail("acc", 0);
        el("calZStatus").textContent = "开始校准";
        el("calAccStatus").textContent = "开始校准";
        return;
    }
    if (parts[1] === "ERROR")
    {
        const code = parts[2] || "UNKNOWN";
        const messages = {
            NO_SENSOR: "无可用传感器", NO_ICM: "ICM未安装或未就绪",
            MOVING: "请停止转动后再完成", REVERSED: "旋转方向改变，校准失败",
            AXIS_SIGN: "两颗Z轴方向不一致", SENSOR_LOST: "传感器掉线",
            XV_RANGE: "XV结果超出范围", ICM_RANGE: "ICM结果超出范围",
            ACC_RANGE: "六面结果超出范围", FLASH: "Flash保存失败",
            BUSY: "校准任务正在运行", BAD_STATE: "当前状态不能执行"
        };
        const message = messages[code] || `校准失败：${code}`;
        if (calibrationState.phase.startsWith("acc")) { el("calAccStatus").textContent = message; }
        else { el("calZStatus").textContent = message; }
        if (!["MOVING", "FLASH", "BUSY"].includes(code))
        {
            setCalibrationBusy("idle");
        }
        else
        {
            updateCalibrationButtons();
        }
        showToast(message, "error");
    }
}
function closeOtaModal()
{
    if (otaEngine.isBusy)
    {
        showToast("升级进行中，请先中止 OTA 升级", "warning");
        return;
    }
    el("otaModal").style.display = "none";
}

// =============================================================================
// 2. IMU 监控配置与硬件能力约束 (XV / ICM / FUS)
// =============================================================================
function updateConfigConstraints()
{
    const dev = el("selectDev").value;
    const fmt = el("selectFmt").value;
    const typeSelect = el("selectDataType");
    const freqSelect = el("selectFreq");
    const fusHint = el("fusHintBox");

    // 1. XV 器件能力约束 (XV 不支持 ACC，仅 Z 轴有效)
    const optAcc = typeSelect.querySelector("option[value='ACC']");
    if (dev === "XV")
    {
        if (optAcc) { optAcc.disabled = true; }
        if (typeSelect.value === "ACC")
        {
            typeSelect.value = "GYRO";
            showToast("XV7021 备用陀螺仪不支持加速度 (ACC)", "warning");
        }
    }
    else
    {
        if (optAcc) { optAcc.disabled = false; }
    }

    // 2. FUS 双器件在线提示
    if (fusHint)
    {
        fusHint.style.display = dev === "FUS" ? "block" : "none";
    }

    // 3. TXT 格式上报频率限制 (<= 200Hz)
    const opt500 = freqSelect.querySelector("option[value='500']");
    const opt1000 = freqSelect.querySelector("option[value='1000']");
    if (fmt === "TXT")
    {
        if (opt500) { opt500.disabled = true; }
        if (opt1000) { opt1000.disabled = true; }
        if (Number(freqSelect.value) > 200)
        {
            freqSelect.value = "200";
            showToast("TXT 文本格式最高支持 200Hz，极速请选择 JF 二进制格式", "info");
        }
    }
    else
    {
        if (opt500) { opt500.disabled = false; }
        if (opt1000) { opt1000.disabled = false; }
    }

    // 4. 更新指令预览
    const curType = typeSelect.value;
    const curFreq = freqSelect.value;
    serialHub.setTelemetryConfig(dev, fmt, curType, curFreq);
    const cmd = `${dev}/${fmt}/${curType}/${curFreq}\\r\\n`;
    if (el("cmdPreviewText"))
    {
        el("cmdPreviewText").textContent = cmd;
    }

    // 5. 更新模式徽章
    if (el("stageSourceTag"))
    {
        const fmtName = fmt === "JF" ? "JustFloat" : "TXT 文本";
        const typeName = curType === "EULER" ? "欧拉角" : (curType === "QUAT" ? "四元数" : (curType === "ACC" ? "加速度" : "角速度"));
        el("stageSourceTag").textContent = `${dev} · ${fmtName} · ${typeName}`;
    }

    // 6. 更新数值卡片单位与标签定义
    updateValuesCardLayout(curType);
    saveMonitorConfig();
    window.syncGlassSelects?.();
}

function updateValuesCardLayout(dataType)
{
    const isQuat = dataType === "QUAT";
    const isAcc = dataType === "ACC";
    const isGyro = dataType === "GYRO";
    const isEuler = dataType === "EULER";

    const box4 = el("valBox4");
    const grid = el("valuesGrid");

    if (box4) { box4.style.display = isQuat ? "flex" : "none"; }
    if (grid) { grid.className = isQuat ? "values-grid-4col" : "values-grid-3col"; }

    // 动态标签与单位
    if (isAcc)
    {
        el("valLabel1").textContent = "Acc X"; el("valUnit1").textContent = "g";
        el("valLabel2").textContent = "Acc Y"; el("valUnit2").textContent = "g";
        el("valLabel3").textContent = "Acc Z"; el("valUnit3").textContent = "g";
    }
    else if (isGyro)
    {
        el("valLabel1").textContent = "Gyro X"; el("valUnit1").textContent = "dps";
        el("valLabel2").textContent = "Gyro Y"; el("valUnit2").textContent = "dps";
        el("valLabel3").textContent = "Gyro Z"; el("valUnit3").textContent = "dps";
    }
    else if (isEuler)
    {
        el("valLabel1").textContent = "Roll (X 翻滚)"; el("valUnit1").textContent = "deg";
        el("valLabel2").textContent = "Pitch (Y 俯仰)"; el("valUnit2").textContent = "deg";
        el("valLabel3").textContent = "Yaw (Z 偏航)"; el("valUnit3").textContent = "deg";
    }
    else if (isQuat)
    {
        el("valLabel1").textContent = "Quat W (标量)"; el("valUnit1").textContent = "-";
        el("valLabel2").textContent = "Quat X"; el("valUnit2").textContent = "-";
        el("valLabel3").textContent = "Quat Y"; el("valUnit3").textContent = "-";
        el("valLabel4").textContent = "Quat Z"; el("valUnit4").textContent = "-";
    }

    // 3D 姿态模型暂停遮罩 (ACC/GYRO 模式下提示)
    const mask = el("mask3dPaused");
    if (mask)
    {
        mask.style.display = (isAcc || isGyro) ? "flex" : "none";
    }

    const labels = isQuat ? ["W", "X", "Y", "Z"] :
        (isEuler ? ["Roll", "Pitch", "Yaw", "CH4"] : ["X", "Y", "Z", "CH4"]);
    labels.forEach((label, index) =>
    {
        if (el(`termChLabel${index + 1}`))
        {
            el(`termChLabel${index + 1}`).textContent = label;
        }
    });
}

// =============================================================================
// 3. 数据流接收与 UI 实时联动 (通道映射解算 + 3D 姿态驱动)
// =============================================================================
let lastRateCalcTime = performance.now();
let framesInWindow = 0;
let lastValuesUpdate = 0;
let detectedChannelCount = 3;

serialHub.onFrame = frame =>
{
    framesInWindow++;
    const now = performance.now();
    const vals = frame.values;

    detectedChannelCount = vals.length;
    if (el("tagChannelCount"))
    {
        el("tagChannelCount").textContent = `CH: ${detectedChannelCount}`;
    }

    // 姿态映射绑定：用户可根据四通道自由映射每个轴对应的通道
    const getMappedVal = (selectId, defaultIndex) =>
    {
        const selVal = el(selectId)?.value;
        if (selVal === "zero") return 0;
        const idx = (selVal !== undefined && selVal !== null && selVal !== "") ? Number(selVal) : defaultIndex;
        return Number.isInteger(idx) && Number.isFinite(vals[idx]) ? vals[idx] : 0;
    };

    const rollVal = getMappedVal("mapRoll", 0);
    const pitchVal = getMappedVal("mapPitch", 1);
    const yawVal = getMappedVal("mapYaw", 2);

    // 2. 驱动 3D 姿态正方体旋转
    if (cubeRenderer)
    {
        if (frame.dataType === "QUAT")
        {
            const w = Number.isFinite(vals[0]) ? vals[0] : 1;
            const x = Number.isFinite(vals[1]) ? vals[1] : 0;
            const y = Number.isFinite(vals[2]) ? vals[2] : 0;
            const z = Number.isFinite(vals[3]) ? vals[3] : 0;
            cubeRenderer.setPoseQuat([w, x, y, z]);
        }
        else
        {
            cubeRenderer.setPoseEuler(rollVal, pitchVal, yawVal);
        }
    }

    // 3. 节流更新数值看板 (25 Hz UI 刷新率，保证极致流畅且不占 CPU)
    if (now - lastValuesUpdate > 40)
    {
        lastValuesUpdate = now;
        const fmtVal = (v, digits = 2) => (Number.isFinite(v) ? v.toFixed(digits) : "N/A");
        const digits = (frame.dataType === "QUAT") ? 4 : (frame.dataType === "ACC" || frame.dataType === "GYRO" ? 3 : 2);

        for (let i = 0; i < 4; i++)
        {
            const displayValue = Number.isFinite(vals[i]) ? fmtVal(vals[i], digits) : "--";
            if (el(`valNum${i + 1}`)) { el(`valNum${i + 1}`).textContent = displayValue; }
            if (el(`termChValue${i + 1}`)) { el(`termChValue${i + 1}`).textContent = displayValue; }
        }

        // 更新右上角指标
        if (el("statValidFrames")) { el("statValidFrames").textContent = String(serialHub.frameCount); }
        if (el("statErrorFrames")) { el("statErrorFrames").textContent = String(serialHub.errorFrameCount); }
        if (el("statDroppedFrames")) { el("statDroppedFrames").textContent = String(serialHub.droppedFrameCount); }
    }
};

serialHub.onStateChange = state =>
{
    updateSerialStateUi(state);
    if (state === SerialState.RECEIVING)
    {
        addTerminalLog("设备在线，持续接收有效遥测数据流", "success");
    }
    else if (state === SerialState.ERROR)
    {
        addTerminalLog("串口连接异常中断", "error");
        if (calibrationState.busy)
        {
            el("calZStatus").textContent = "串口已断开";
            el("calAccStatus").textContent = "串口已断开";
        }
    }
};

serialHub.onError = err =>
{
    const message = typeof err === "string" ? err : err.message;
    addTerminalLog(message, "error");
    showToast(message, "error");
};

let lastRawLogTime = 0;

serialHub.onRawData = chunk =>
{
    const mode = el("selectRawMode") ? el("selectRawMode").value : "txt";
    const now = performance.now();
    if (mode === "hex" && now - lastRawLogTime >= 100)
    {
        lastRawLogTime = now;
        const hex = Array.from(chunk.slice(0, 32)).map(b => b.toString(16).padStart(2, "0").toUpperCase()).join(" ");
        addTerminalLog(`[RX HEX] ${hex}${chunk.length > 32 ? " ..." : ""}`, "rx");
    }
};

serialHub.onRawText = lineText =>
{
    const mode = el("selectRawMode") ? el("selectRawMode").value : "txt";
    const now = performance.now();
    if (mode === "txt" && now - lastRawLogTime >= 100)
    {
        lastRawLogTime = now;
        addTerminalLog(`[RX TXT] ${lineText}`, "rx");
    }
};
serialHub.onCalibration = handleCalibrationLine;

// 1秒统计定时器
setInterval(() =>
{
    const now = performance.now();
    const elapsed = (now - lastRateCalcTime) / 1000;
    const rate = elapsed > 0 ? (framesInWindow / elapsed).toFixed(1) : "0.0";
    framesInWindow = 0;
    lastRateCalcTime = now;

    if (el("statActualFreq")) { el("statActualFreq").textContent = `${rate} Hz`; }
    if (el("tagDataRate")) { el("tagDataRate").textContent = `${rate} Hz`; }

    // 持续时间
    if (serialHub.isConnected && serialHub.connectionStartTime > 0)
    {
        const totalSec = Math.floor((now - serialHub.connectionStartTime) / 1000);
        const hh = String(Math.floor(totalSec / 3600)).padStart(2, "0");
        const mm = String(Math.floor((totalSec % 3600) / 60)).padStart(2, "0");
        const ss = String(totalSec % 60).padStart(2, "0");
        if (el("statDuration")) { el("statDuration").textContent = `${hh}:${mm}:${ss}`; }
    }

    if (el("statTotalBytes")) { el("statTotalBytes").textContent = `${(serialHub.byteCount / 1024).toFixed(1)} KB`; }
}, 1000);

// =============================================================================
// 4. 开发模拟数据发生器 (1kHz)
// =============================================================================
class DevelopmentMockStreamer
{
    constructor()
    {
        this.isRunning = false;
        this.timer = null;
        this.simTime = 0;
    }

    start(freq = 100)
    {
        this.stop();
        this.isRunning = true;
        this.simTime = 0;
        const intervalMs = Math.max(1, 1000 / freq);

        addTerminalLog(`已启动开发模拟数据发生器 (${freq} Hz)`, "info");

        this.timer = setInterval(() =>
        {
            if (!this.isRunning) { return; }
            this.simTime += intervalMs / 1000;
            const t = this.simTime;

            const roll = Math.sin(t * 2.5) * 35.0;
            const pitch = Math.cos(t * 1.8) * 25.0;
            const yaw = (t * 30.0) % 360.0 - 180.0;
            let vals;
            const dataType = serialHub.config.dataType;
            if (dataType === "QUAT")
            {
                const halfRoll = roll * Math.PI / 360;
                const halfPitch = pitch * Math.PI / 360;
                const halfYaw = yaw * Math.PI / 360;
                const cr = Math.cos(halfRoll), sr = Math.sin(halfRoll);
                const cp = Math.cos(halfPitch), sp = Math.sin(halfPitch);
                const cy = Math.cos(halfYaw), sy = Math.sin(halfYaw);
                vals = [
                    cr * cp * cy + sr * sp * sy,
                    sr * cp * cy - cr * sp * sy,
                    cr * sp * cy + sr * cp * sy,
                    cr * cp * sy - sr * sp * cy
                ];
            }
            else if (dataType === "ACC")
            {
                vals = [Math.sin(t) * 0.2, Math.cos(t * 0.8) * 0.2, 1.0];
            }
            else if (dataType === "GYRO")
            {
                vals = [Math.cos(t * 2.5) * 87.5, -Math.sin(t * 1.8) * 45.0, 30.0];
            }
            else
            {
                vals = [roll, pitch, yaw];
            }

            serialHub.frameCount++;
            serialHub.lastFrameTime = performance.now();
            serialHub.setState(SerialState.RECEIVING);

            serialHub.onFrame({
                raw: vals,
                values: vals,
                device: serialHub.config.device,
                dataType: serialHub.config.channelMode === "raw" ? "RAW_MAPPED" : serialHub.config.dataType,
                channelMode: serialHub.config.channelMode,
                format: serialHub.config.format,
                timestamp: serialHub.lastFrameTime
            });
        }, intervalMs);
    }

    stop()
    {
        if (this.isRunning)
        {
            this.isRunning = false;
            if (this.timer) { clearInterval(this.timer); this.timer = null; }
            addTerminalLog("开发模拟数据发生器已停止", "info");
        }
    }
}

const devSim = new DevelopmentMockStreamer();

// =============================================================================
// 5. 预置固件库与本地上传双模 OTA 弹窗引擎 (100% 对齐 FOC Studio)
// =============================================================================
function base64ToUint8Array(base64)
{
    const binaryString = atob(base64);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++)
    {
        bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes;
}

function initPresetFirmwares()
{
    const select = el("selectPresetFirmware");
    const descBox = el("presetDesc");
    if (!select || !window.PRESET_FIRMWARES) { return; }

    select.innerHTML = "";
    window.PRESET_FIRMWARES.forEach((fw, idx) =>
    {
        const opt = document.createElement("option");
        opt.value = idx;
        opt.textContent = `${fw.name} (${fw.version})`;
        if (fw.isDefault) { opt.selected = true; }
        select.appendChild(opt);
    });
    window.syncGlassSelects?.();

    select.addEventListener("change", () =>
    {
        const fw = window.PRESET_FIRMWARES[select.value];
        if (fw)
        {
            descBox.textContent = fw.desc;
            loadPresetFirmware(fw);
        }
    });

    // 默认加载首项预置固件
    if (window.PRESET_FIRMWARES.length > 0)
    {
        const defaultFw = window.PRESET_FIRMWARES.find(f => f.isDefault) || window.PRESET_FIRMWARES[0];
        descBox.textContent = defaultFw.desc;
        loadPresetFirmware(defaultFw);
    }
}

async function loadPresetFirmware(fw)
{
    try
    {
        let buffer;
        const embeddedBase64 = fw.dataVariable ? window[fw.dataVariable] : fw.base64;
        if (embeddedBase64)
        {
            // Why: 保存变量名而不是初始化时的值，确保 firmware_data.js 加载后再读取完整固件。
            buffer = base64ToUint8Array(embeddedBase64).buffer;
        }
        else
        {
            if (!fw.path)
            {
                throw new Error("预置固件数据不存在，请运行同步IMU固件脚本");
            }
            const resp = await fetch(fw.path);
            if (!resp.ok) { throw new Error(`无法下载预置固件: HTTP ${resp.status}`); }
            buffer = await resp.arrayBuffer();
        }

        const res = otaEngine.validateFirmware(buffer, fw.name);
        el("otaFileName").textContent = fw.name;
        el("otaFileSize").textContent = `${res.size} B (${(res.size / 1024).toFixed(1)} KB)`;
        el("otaFileCrc").textContent = res.crcHex;

        updateOtaStartButton();
        addOtaConsoleLog(`[预置固件就绪] ${fw.name} (${fw.version}) 校验通过 (CRC32: ${res.crcHex})`, "success");
    }
    catch (err)
    {
        otaEngine.clearFirmware();
        updateOtaStartButton();
        el("otaFileName").textContent = "--";
        el("otaFileSize").textContent = "--";
        el("otaFileCrc").textContent = "--";
        showToast(err.message, "error");
        addOtaConsoleLog(`[预置固件加载失败] ${err.message}`, "error");
    }
}

function setupOtaModalEvents()
{
    // 双 Tab 切换 (预置固件库 vs 本地上传)
    el("tabPresetFirmware")?.addEventListener("click", () =>
    {
        el("tabPresetFirmware").classList.add("active");
        el("tabCustomFirmware").classList.remove("active");
        el("otaPresetSection").style.display = "flex";
        el("otaUploadSection").style.display = "none";

        const sel = el("selectPresetFirmware");
        if (sel && window.PRESET_FIRMWARES)
        {
            const fw = window.PRESET_FIRMWARES[sel.value];
            if (fw) { loadPresetFirmware(fw); }
        }
    });

    el("tabCustomFirmware")?.addEventListener("click", () =>
    {
        el("tabCustomFirmware").classList.add("active");
        el("tabPresetFirmware").classList.remove("active");
        el("otaUploadSection").style.display = "flex";
        el("otaPresetSection").style.display = "none";
        otaEngine.clearFirmware();
        updateOtaStartButton();
        el("otaFileName").textContent = "--";
        el("otaFileSize").textContent = "--";
        el("otaFileCrc").textContent = "--";
    });

    const dropZone = el("otaDropZone");
    const fileInput = el("otaFileInput");

    dropZone?.addEventListener("click", () => fileInput.click());
    dropZone?.addEventListener("dragover", e => { e.preventDefault(); dropZone.classList.add("dragover"); });
    dropZone?.addEventListener("dragleave", () => dropZone.classList.remove("dragover"));
    dropZone?.addEventListener("drop", e =>
    {
        e.preventDefault();
        dropZone.classList.remove("dragover");
        if (e.dataTransfer.files.length > 0)
        {
            handleFirmwareFile(e.dataTransfer.files[0]);
        }
    });

    fileInput?.addEventListener("change", e =>
    {
        if (e.target.files.length > 0)
        {
            handleFirmwareFile(e.target.files[0]);
        }
    });

    async function handleFirmwareFile(file)
    {
        try
        {
            const buffer = await file.arrayBuffer();
            const res = otaEngine.validateFirmware(buffer, file.name);

            el("otaFileName").textContent = file.name;
            el("otaFileSize").textContent = `${res.size} B (${(res.size / 1024).toFixed(1)} KB)`;
            el("otaFileCrc").textContent = res.crcHex;

            updateOtaStartButton();
            showToast("固件 4 项安全校验全部通过", "success");
            addOtaConsoleLog(`[本地固件校验通过] ${file.name} (大小: ${res.size} B, CRC32: ${res.crcHex})`, "success");
        }
        catch (err)
        {
            otaEngine.clearFirmware();
            fileInput.value = "";
            updateOtaStartButton();
            el("otaFileName").textContent = "--";
            el("otaFileSize").textContent = "--";
            el("otaFileCrc").textContent = "--";
            showToast(err.message, "error");
            addOtaConsoleLog(`[固件拦截] ${err.message}`, "error");
        }
    }

    const stepElements = [
        el("stepTrigger"),
        el("stepHandshake"),
        el("stepErase"),
        el("stepData"),
        el("stepVerify"),
        el("stepComplete")
    ];

    otaEngine.onStepChange = (stepIdx, stepName) =>
    {
        const mappedIdx = Math.min(6, stepIdx);
        stepElements.forEach((node, idx) =>
        {
            if (!node) { return; }
            if (idx + 1 < mappedIdx) { node.className = "step-item done"; }
            else if (idx + 1 === mappedIdx) { node.className = "step-item active"; }
            else { node.className = "step-item"; }
        });
    };

    otaEngine.onProgress = prog =>
    {
        el("otaProgressBar").style.width = `${prog.percent}%`;
        el("otaPercentText").textContent = `${prog.percent}%`;
        el("otaBytesText").textContent = `${prog.currentBytes} / ${prog.totalBytes} B (包 ${prog.packetIndex}/${prog.totalPackets})`;
        el("otaSpeedText").textContent = `${prog.speedKb} KB/s`;
    };

    otaEngine.onLog = (msg, type) =>
    {
        addOtaConsoleLog(msg, type);
    };

    // 开始升级
    el("btnStartOta")?.addEventListener("click", async () =>
    {
        if (calibrationState.busy)
        {
            showToast("校准中，不能执行OTA", "warning");
            return;
        }
        if (!otaEngine.firmwareData)
        {
            const message = "请先选择并完成固件校验";
            showToast(message, "warning");
            addOtaConsoleLog(`[无法开始] ${message}`, "warning");
            return;
        }
        if (!serialHub.isConnected)
        {
            const message = "请先连接串口，再开始 OTA 升级";
            showToast(message, "warning");
            addOtaConsoleLog(`[无法开始] ${message}`, "warning");
            return;
        }

        el("btnStartOta").disabled = true;
        el("btnAbortOta").disabled = false;
        try
        {
            const upgrade = otaEngine.startUpgrade("1.1.0");
            updateOtaStartButton();
            updateCalibrationButtons();
            await upgrade;
            showToast("MSPM0G3507 固件升级成功", "success");
        }
        catch (e)
        {
            showToast(e.message, "error");
        }
        finally
        {
            updateOtaStartButton();
            el("btnAbortOta").disabled = true;
            updateCalibrationButtons();
        }
    });

    // 中止升级
    el("btnAbortOta")?.addEventListener("click", () =>
    {
        if (confirm("⚠️ 警告：中止升级可能导致设备停留在 Bootloader，必须重新升级才能正常运行。确定中止吗？"))
        {
            otaEngine.cancelUpgrade();
            el("btnAbortOta").disabled = true;
            showToast("已中止 OTA 升级", "warning");
        }
    });

    el("btnClearOtaLog")?.addEventListener("click", () =>
    {
        el("otaLogConsole").innerHTML = "";
    });

    initPresetFirmwares();
}

// =============================================================================
// 6. 页面事件全量绑定与初始化
// =============================================================================
function bindAllEvents()
{
    const switchMainPanel = calibration =>
    {
        el("tabMonitorMode")?.classList.toggle("active", !calibration);
        el("tabCalibrationMode")?.classList.toggle("active", calibration);
        el("monitorControlPanel")?.classList.toggle("active", !calibration);
        el("calibrationControlPanel")?.classList.toggle("active", calibration);
        if (calibration && serialHub.isConnected)
        {
            sendCalibrationCommand("CAL/READ").catch(e => showToast(e.message, "error"));
        }
    };
    const switchCalibrationKind = kind =>
    {
        el("tabCalZ")?.classList.toggle("active", kind === "z");
        el("tabCalAcc")?.classList.toggle("active", kind === "acc");
        el("calZPanel")?.classList.toggle("active", kind === "z");
        el("calAccPanel")?.classList.toggle("active", kind === "acc");
    };

    el("tabMonitorMode")?.addEventListener("click", () => switchMainPanel(false));
    el("tabCalibrationMode")?.addEventListener("click", () => switchMainPanel(true));
    el("tabCalZ")?.addEventListener("click", () => switchCalibrationKind("z"));
    el("tabCalAcc")?.addEventListener("click", () => switchCalibrationKind("acc"));
    el("btnCalRead")?.addEventListener("click", () => sendCalibrationCommand("CAL/READ"));
    el("btnCalZStart")?.addEventListener("click", () => sendCalibrationCommand("CAL/Z/START"));
    el("btnCalZFinish")?.addEventListener("click", () => sendCalibrationCommand("CAL/Z/FINISH"));
    el("btnCalZSave")?.addEventListener("click", () => sendCalibrationCommand("CAL/Z/SAVE"));
    el("btnCalZDefault")?.addEventListener("click", () => sendCalibrationCommand("CAL/Z/DEFAULT"));
    el("btnCalAccStart")?.addEventListener("click", () => sendCalibrationCommand("CAL/ACC/START"));
    el("btnCalAccSave")?.addEventListener("click", () => sendCalibrationCommand("CAL/ACC/SAVE"));
    el("btnCalAccDefault")?.addEventListener("click", () => sendCalibrationCommand("CAL/ACC/DEFAULT"));
    el("btnCalCancel")?.addEventListener("click", () => sendCalibrationCommand("CAL/CANCEL"));
    el("btnCalAccCancel")?.addEventListener("click", () => sendCalibrationCommand("CAL/CANCEL"));

    // 顶栏 OTA 弹窗打开/关闭
    el("btnOpenOtaModal")?.addEventListener("click", openOtaModal);
    el("btnCloseOtaModal")?.addEventListener("click", closeOtaModal);
    el("otaModal")?.addEventListener("click", event =>
    {
        if (event.target === el("otaModal")) { closeOtaModal(); }
    });
    window.addEventListener("keydown", event =>
    {
        if (event.key === "Escape" && el("otaModal")?.style.display !== "none")
        {
            closeOtaModal();
        }
    });

    // 串口参数固定，直接选择端口连接，避免没有实际配置项的中间弹窗。
    el("btnConnect")?.addEventListener("click", async event =>
    {
        const button = event.currentTarget;
        button.disabled = true;
        try
        {
            if (serialHub.isConnected)
            {
                await serialHub.disconnect();
                addTerminalLog("串口已关闭", "warning");
                showToast("串口已断开", "info");
            }
            else
            {
                await serialHub.connect();
                addTerminalLog("串口已打开 [460800 8-N-1]", "success");
                showToast("串口已打开", "success");
            }
        }
        catch (err)
        {
            addTerminalLog(err.message, "error");
            showToast(err.message, "error");
        }
        finally
        {
            button.disabled = false;
        }
    });

    // 四段式配置联动
    ["selectDev", "selectFmt", "selectDataType", "selectFreq"].forEach(id =>
    {
        el(id)?.addEventListener("change", updateConfigConstraints);
    });
    ["mapRoll", "mapPitch", "mapYaw"].forEach(id =>
    {
        el(id)?.addEventListener("change", saveMonitorConfig);
    });

    // 监控操作按钮
    el("btnStartMonitoring")?.addEventListener("click", async () =>
    {
        const dev = el("selectDev").value;
        const fmt = el("selectFmt").value;
        const type = el("selectDataType").value;
        const freq = el("selectFreq").value;
        try
        {
            const cmd = await serialHub.applyConfig(dev, fmt, type, freq);
            addTerminalLog(`[TX] 发送监控启动指令: ${cmd.trim()}`, "tx");
            showToast("已下发配置并开始监控", "success");
        }
        catch (e) { showToast(e.message, "error"); }
    });

    el("btnApplyConfig")?.addEventListener("click", async () =>
    {
        const dev = el("selectDev").value;
        const fmt = el("selectFmt").value;
        const type = el("selectDataType").value;
        const freq = el("selectFreq").value;
        try
        {
            const cmd = await serialHub.applyConfig(dev, fmt, type, freq);
            addTerminalLog(`[TX] 应用新配置: ${cmd.trim()}`, "tx");
            showToast("配置已更新", "success");
        }
        catch (e) { showToast(e.message, "error"); }
    });

    el("btnStopMonitoring")?.addEventListener("click", async () =>
    {
        try
        {
            await serialHub.stopMonitoring();
            addTerminalLog("[TX] 已发送 STOP 停止监控", "warning");
            showToast("已停止监控", "info");
        }
        catch (e) { showToast(e.message, "error"); }
    });

    // 3D 姿态操作按钮
    el("btnTare")?.addEventListener("click", () => { cubeRenderer?.setTare(); showToast("3D 姿态已归零 (Tare)", "info"); });
    el("btnResetTare")?.addEventListener("click", () => { cubeRenderer?.resetTare(); showToast("已恢复绝对姿态", "info"); });
    el("btnResetCamera")?.addEventListener("click", () => { cubeRenderer?.resetCamera(); showToast("视角已复位", "info"); });

    el("btnToggleAxes")?.addEventListener("click", e =>
    {
        if (cubeRenderer)
        {
            cubeRenderer.showAxes = !cubeRenderer.showAxes;
            e.currentTarget.classList.toggle("active", cubeRenderer.showAxes);
            cubeRenderer.render();
        }
    });

    el("btnToggleGrid")?.addEventListener("click", e =>
    {
        if (cubeRenderer)
        {
            cubeRenderer.showGrid = !cubeRenderer.showGrid;
            e.currentTarget.classList.toggle("active", cubeRenderer.showGrid);
            cubeRenderer.render();
        }
    });

    // =========================================================================
    // 发送历史记录系统 (最大 10 条，支持单独删除与一键清空)
    // =========================================================================
    const STORAGE_KEY_HISTORY = "imu_studio_send_history_v1";
    let sendHistoryList = [];

    function loadSendHistory()
    {
        try
        {
            const saved = localStorage.getItem(STORAGE_KEY_HISTORY);
            if (saved) { sendHistoryList = JSON.parse(saved); }
        }
        catch (e) { sendHistoryList = []; }
        renderHistoryList();
    }

    function saveSendHistory()
    {
        try { localStorage.setItem(STORAGE_KEY_HISTORY, JSON.stringify(sendHistoryList)); }
        catch (e) {}
        renderHistoryList();
    }

    function addSendHistoryItem(text, mode)
    {
        if (!text) { return; }
        // 过滤重复项并移到最前
        sendHistoryList = sendHistoryList.filter(item => item.text !== text);
        sendHistoryList.unshift({ text, mode, time: Date.now() });
        if (sendHistoryList.length > 10) { sendHistoryList.pop(); }
        saveSendHistory();
    }

    function deleteSendHistoryItem(index, e)
    {
        if (e) { e.stopPropagation(); }
        sendHistoryList.splice(index, 1);
        saveSendHistory();
    }

    function renderHistoryList()
    {
        const container = el("historyList");
        if (!container) { return; }
        container.innerHTML = "";

        if (sendHistoryList.length === 0)
        {
            const empty = document.createElement("div");
            empty.className = "history-empty-hint";
            empty.textContent = "暂无发送历史记录";
            container.appendChild(empty);
            return;
        }

        sendHistoryList.forEach((item, idx) =>
        {
            const row = document.createElement("div");
            row.className = "history-item";

            const badge = document.createElement("span");
            badge.className = `history-badge ${item.mode === "hex" ? "hex" : "txt"}`;
            badge.textContent = item.mode === "hex" ? "HEX" : "TXT";

            const textSpan = document.createElement("span");
            textSpan.className = "history-text";
            textSpan.textContent = item.text;
            textSpan.title = item.text;

            const delBtn = document.createElement("button");
            delBtn.className = "btn-del-history-item";
            delBtn.innerHTML = "&times;";
            delBtn.title = "删除此条历史记录";
            delBtn.addEventListener("click", ev => deleteSendHistoryItem(idx, ev));

            row.appendChild(badge);
            row.appendChild(textSpan);
            row.appendChild(delBtn);

            row.addEventListener("click", () =>
            {
                if (el("inputCmdSend"))
                {
                    el("inputCmdSend").value = item.text;
                    el("inputCmdSend").focus();
                }
                if (el("selectSendMode"))
                {
                    el("selectSendMode").value = item.mode;
                }
                el("historyPopup").style.display = "none";
            });

            container.appendChild(row);
        });
    }

    el("btnToggleHistory")?.addEventListener("click", e =>
    {
        e.stopPropagation();
        const popup = el("historyPopup");
        if (popup)
        {
            const isShown = popup.style.display === "block";
            popup.style.display = isShown ? "none" : "block";
        }
    });

    document.addEventListener("click", e =>
    {
        const popup = el("historyPopup");
        if (popup && popup.style.display === "block")
        {
            if (!popup.contains(e.target) && e.target !== el("btnToggleHistory"))
            {
                popup.style.display = "none";
            }
        }
    });

    el("btnClearAllHistory")?.addEventListener("click", () =>
    {
        sendHistoryList = [];
        saveSendHistory();
        showToast("已清空全部发送历史", "info");
    });

    // 串口发送与清屏 (支持 TXT / HEX 双格式与结束符追加)
    el("btnClearLog")?.addEventListener("click", () =>
    {
        el("terminalOutputBox").innerHTML = "";
    });

    const sendUserCmd = async () =>
    {
        const input = el("inputCmdSend");
        const val = input.value.trim();
        if (!val) { return; }

        const mode = el("selectSendMode") ? el("selectSendMode").value : "txt";
        const suffixOpt = el("selectSendSuffix") ? el("selectSendSuffix").value : "\\r\\n";

        let suffixStr = "";
        if (suffixOpt === "\\r\\n") { suffixStr = "\r\n"; }
        else if (suffixOpt === "\\n") { suffixStr = "\n"; }

        try
        {
            if (mode === "hex")
            {
                // 解析 HEX 字符串 (如 "FF 01 02 FE" 或 "FF0102FE")
                const hexClean = val.replace(/[\s,;-]/g, "");
                if (hexClean.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hexClean))
                {
                    throw new Error("HEX 格式错误：请输入偶数位有效十六进制字符 (如 FF 01 02 FE)");
                }
                const bytes = new Uint8Array(hexClean.length / 2);
                for (let i = 0; i < hexClean.length; i += 2)
                {
                    bytes[i / 2] = parseInt(hexClean.substr(i, 2), 16);
                }
                await serialHub.sendBytes(bytes);
                addTerminalLog(`[TX HEX] ${val}`, "tx");
            }
            else
            {
                // TXT 文本发送
                const fullText = val + suffixStr;
                await serialHub.sendText(fullText);
                addTerminalLog(`[TX TXT] ${val}`, "tx");
            }

            addSendHistoryItem(val, mode);
            input.value = "";
        }
        catch (err)
        {
            showToast(err.message, "error");
        }
    };

    el("btnSendCmd")?.addEventListener("click", sendUserCmd);
    el("inputCmdSend")?.addEventListener("keydown", e =>
    {
        if (e.key === "Enter") { sendUserCmd(); }
    });

    loadSendHistory();

    // 模拟推流按钮
    el("btnTriggerSim")?.addEventListener("click", e =>
    {
        if (devSim.isRunning)
        {
            devSim.stop();
            e.currentTarget.textContent = "开启模拟推流";
            e.currentTarget.className = "btn-action-slate";
            updateSerialStateUi(SerialState.DISCONNECTED);
        }
        else
        {
            if (serialHub.isConnected)
            {
                showToast("物理串口已连接，请先断开串口再开启模拟", "warning");
                return;
            }
            const mockFrequency = Number(el("selectFreq")?.value) || 100;
            devSim.start(mockFrequency);
            e.currentTarget.textContent = "停止模拟推流";
            e.currentTarget.className = "btn-action-teal";
            updateSerialStateUi(SerialState.RECEIVING);
        }
    });

    setupOtaModalEvents();
}

document.addEventListener("DOMContentLoaded", () =>
{
    loadMonitorConfig();
    bindAllEvents();
    updateConfigConstraints();
    updateSerialStateUi(SerialState.DISCONNECTED);
    updateCalibrationReference();
    updateCalibrationButtons();

    addTerminalLog("IMU Motion Studio 已就绪 (曜石深空工控 · 预置库与本地双模 OTA · 通道映射)", "info");
});
