"use strict";

const COMMAND = {
    ENABLE: 0x01,
    DISABLE: 0x02,
    CLEAR_ELECTRICAL_ZERO: 0x03,
    CURRENT: 0x04,
    SPEED: 0x05,
    LOW_SPEED_TORQUE: 0x06,
    POSITION: 0x07,
    STEP: 0x08,
    MOTOR_ID: 0x09,
    TELEMETRY: 0x44,
    ENCODER_CALIBRATION: 0x6A,
    DIRECT_STEP: 0x70,
    TEMP_ZERO: 0xA2,
    SAVE_ZERO: 0xB2,
    LADRC_QUERY: 0xD0,
    LADRC_SET: 0xD1,
    LADRC_SAVE: 0xD2,
    LADRC_DEFAULTS: 0xD3
};

const LADRC_GROUPS = [
    { name: "Q 轴电流环", shortName: "Q轴", dt: 0.0001, wcMax: 3000, woMax: 6553.5 },
    { name: "D 轴电流环", shortName: "D轴", dt: 0.0001, wcMax: 3000, woMax: 6553.5 },
    { name: "速度环", shortName: "速度", dt: 0.001, wcMax: 300, woMax: 800 },
    { name: "位置环", shortName: "位置", dt: 0.001, wcMax: 300, woMax: 800 }
];

const LADRC_STATUS = {
    0: { text: "RAM 与 Flash 一致", className: "success" },
    1: { text: "RAM 已修改，尚未保存", className: "warning" },
    2: { text: "正在使用代码默认值", className: "neutral" },
    "-1": { text: "操作被下位机拒绝", className: "danger" },
    "-2": { text: "Flash 校验失败", className: "danger" }
};

const TELEMETRY_MODE_NAMES = {
    run: "运行状态",
    standby: "失能待机",
    calibration: "MT6826 自校准",
    raw: "原始通道"
};

const serial = new FocSerial();
const plot = new TelemetryPlot(
    document.getElementById("plotCanvas"),
    document.getElementById("channelLegend"),
    document.getElementById("plotEmpty"),
    document.getElementById("plotRange"),
    document.getElementById("plotTooltip"),
    document.getElementById("plotAxisHint"),
    {
        container: document.getElementById("plotOverview"),
        window: document.getElementById("plotOverviewWindow"),
        start: document.getElementById("plotOverviewStart"),
        end: document.getElementById("plotOverviewEnd"),
        latest: document.getElementById("plotOverviewLatest")
    }
);

plot.onAutoScaleChange = enabled =>
{
    element("autoScale").checked = enabled;
};
plot.onPausedChange = paused =>
{
    plotPaused = paused;
    element("btnPausePlot").textContent = paused ? "继续曲线" : "暂停曲线";
};
plot.onXViewChange = state =>
{
    element("xAuto").checked = state.xAuto;
    element("plotDeltaT").textContent = `${state.periodMs} ms`;
    element("plotXDiv").textContent = `${plot.formatTime(state.xPerDivMs)}/X-div`;
    if (document.activeElement !== element("plotXStart"))
    {
        element("plotXStart").value = String(Number(state.startMs.toFixed(3)));
    }
    if (document.activeElement !== element("plotXEnd"))
    {
        element("plotXEnd").value = String(Number(state.endMs.toFixed(3)));
    }
};

const markerWaiters = new Map();
const ladrcCurrentValues = Array.from({ length: 4 }, () => null);
let frameWindowCount = 0;
let frameWindowStart = performance.now();
let plotPaused = false;
let telemetryRequested = false;
let lastOrdinaryTelemetryAt = 0;
let lastMeasuredTelemetryRate = 0;
let resolvedTelemetryMode = "run";
let lastMotorId = null;
let ladrcTaskBusy = false;
let otaApplicationFrameWaiter = null;

function element(id)
{
    return document.getElementById(id);
}

function addLog(message, type = "info")
{
    const output = element("logOutput");
    const line = document.createElement("div");
    line.className = `log-line ${type}`;
    line.textContent = `[${new Date().toLocaleTimeString("zh-CN", { hour12: false })}] ${message}`;
    output.appendChild(line);
    while (output.children.length > 300)
    {
        output.firstElementChild.remove();
    }
    output.scrollTop = output.scrollHeight;
}

function showToast(message, type = "info")
{
    const toast = document.createElement("div");
    toast.className = `toast ${type}`;
    toast.textContent = message;
    element("toastContainer").appendChild(toast);
    window.setTimeout(() => toast.remove(), 3200);
}

function setBadge(target, text, className)
{
    target.textContent = text;
    target.className = `badge ${className}`;
}

function updateConnectionUi(connected)
{
    element("connectionIndicator").className = `status-dot ${connected ? "online" : "offline"}`;
    element("connectionText").textContent = connected ? "已连接" : "未连接";
    const btnConnect = element("btnConnect");
    if (connected)
    {
        btnConnect.className = "btn-disconnect";
        btnConnect.innerHTML = `
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
            <span>断开串口</span>`;
    }
    else
    {
        btnConnect.className = "btn-connect-ready";
        btnConnect.innerHTML = `
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M5 12h14"></path>
                <path d="M12 5l7 7-7 7"></path>
            </svg>
            <span>连接串口</span>`;
    }
    document.querySelectorAll(".requires-connection").forEach(button =>
    {
        button.disabled = !connected;
    });

    if (!connected)
    {
        telemetryRequested = false;
        lastOrdinaryTelemetryAt = 0;
        lastMeasuredTelemetryRate = 0;
        lastMotorId = null;
        setBadge(element("telemetryBadge"), "已关闭", "neutral");
        element("currentMotorId").textContent = "未知";
        element("motorIdReadbackHint").textContent = "等待失能待机帧";
        element("telemetrySchemaHint").textContent = "等待普通遥测数据以识别字段格式";
        rejectAllMarkerWaiters(new Error("串口已断开"));
    }
}

function applyTelemetrySchema(mode, reason)
{
    if (!TELEMETRY_MODE_NAMES[mode])
    {
        return;
    }
    const schemaChanged = resolvedTelemetryMode !== mode;
    resolvedTelemetryMode = mode;
    if (schemaChanged)
    {
        // Why: 三种遥测的五个 float 含义不同，旧采样不能套用新标签继续绘制。
        plot.clear();
        plot.setPaused(false);
    }
    plot.setMode(mode);
    element("telemetrySchemaHint").textContent =
        `当前格式：${TELEMETRY_MODE_NAMES[mode]}${reason ? `（${reason}）` : ""}`;
}

function setTelemetryMode(mode)
{
    if (element("telemetryMode").value === "auto")
    {
        applyTelemetrySchema(mode, "根据控制命令预判，收到数据后复核");
    }
}

function isIntegerNear(value)
{
    return Math.abs(value - Math.round(value)) < 0.01;
}

function looksLikeStandbyTelemetry(values)
{
    const adcValuesValid = values[0] >= 0 && values[0] <= 4095 &&
        values[1] >= 0 && values[1] <= 4095 &&
        isIntegerNear(values[0]) && isIntegerNear(values[1]) &&
        (values[0] > 100 || values[1] > 100);
    const angleValid = values[2] >= 0 && values[2] <= 360;
    const busVoltageValid = values[3] >= 0 && values[3] <= 100;
    const motorIdValid = values[4] >= 0 && values[4] <= 9 && isIntegerNear(values[4]);
    return adcValuesValid && angleValid && busVoltageValid && motorIdValid;
}

function updateMotorIdFromStandby(values)
{
    const motorId = Math.round(values[4]);
    if (motorId === lastMotorId)
    {
        return;
    }
    lastMotorId = motorId;
    element("currentMotorId").textContent = String(motorId);
    element("motorIdReadbackHint").textContent = "来自失能待机遥测，已确认";
    if (document.activeElement !== element("inputMotorId"))
    {
        element("inputMotorId").value = String(motorId);
    }
    addLog(`RX 当前 Motor ID: ${motorId}`, "rx");
}

function inferAutomaticModeFromRate(rate)
{
    if (element("telemetryMode").value !== "auto" || rate <= 0)
    {
        return;
    }
    if (rate >= 500)
    {
        applyTelemetrySchema("run", `检测到约 ${rate} Hz`);
    }
    else if (rate >= 20 && rate <= 250)
    {
        applyTelemetrySchema("calibration", `检测到约 ${rate} Hz`);
    }
    else if (rate <= 5)
    {
        applyTelemetrySchema("standby", `检测到约 ${rate} Hz`);
    }
}

function handleOrdinaryTelemetry(values)
{
    frameWindowCount++;
    lastOrdinaryTelemetryAt = performance.now();
    telemetryRequested = true;
    setBadge(element("telemetryBadge"), "设备正在上报", "success");

    if (looksLikeStandbyTelemetry(values))
    {
        updateMotorIdFromStandby(values);
        if (element("telemetryMode").value === "auto")
        {
            applyTelemetrySchema("standby", "待机字段特征已确认");
        }
    }
    plot.addSample(values);
}

function signedPhysicalToRaw(value, span)
{
    if (!Number.isFinite(value) || value < -span || value > span)
    {
        throw new Error(`输入必须位于 ${-span} ～ ${span}`);
    }
    if (value === -span)
    {
        return 0x8000;
    }
    return Math.round((value / span) * 32767) & 0xFFFF;
}

function readNumberInRange(inputId, minimum, maximum, label)
{
    const value = Number(element(inputId).value);
    if (!Number.isFinite(value) || value < minimum || value > maximum)
    {
        throw new Error(`${label}必须位于 ${minimum} ～ ${maximum}`);
    }
    return value;
}

function applyMotionInputLimits(inputId, minimum, maximum, step)
{
    const input = element(inputId);
    input.min = String(minimum);
    input.max = String(maximum);
    input.step = String(step);

    const currentValue = Number(input.value);
    // Why: 从宽量程切换到窄量程时不能保留越界旧值，避免用户直接点击发送造成误操作。
    if (!Number.isFinite(currentValue) || currentValue < minimum || currentValue > maximum)
    {
        input.value = "0";
    }
}

function updateSpeedModeInput()
{
    const isLowSpeedTorque = element("speedMode").value === "lowSpeedTorque";
    applyMotionInputLimits("inputSpeed", isLowSpeedTorque ? -2 : -100,
        isLowSpeedTorque ? 2 : 100, isLowSpeedTorque ? 0.01 : 0.1);
}

function updateStepModeInput()
{
    // 0x08 与 0x70 协议量程相同，仍在切换时显式刷新，防止后续协议调整遗漏界面约束。
    applyMotionInputLimits("inputStep", -2, 2, 0.01);
}

async function sendControl(command, rawData, name)
{
    if (mockGen && mockGen.isRunning)
    {
        if (command === COMMAND.ENABLE) { setTelemetryMode("run"); }
        else if (command === COMMAND.DISABLE) { setTelemetryMode("standby"); }
        else if (command === COMMAND.ENCODER_CALIBRATION) { setTelemetryMode("calibration"); }
        element("commandState").textContent = `[仿真响应] ${name}已生效`;
        addLog(`[仿真模拟] 执行控制命令: ${name}`, "tx");
        showToast(`[仿真响应] ${name}已生效`, "success");
        return;
    }
    await serial.sendCommand(command, rawData, 0);
    if (command === COMMAND.ENABLE)
    {
        setTelemetryMode("run");
    }
    else if (command === COMMAND.DISABLE)
    {
        setTelemetryMode("standby");
    }
    else if (command === COMMAND.ENCODER_CALIBRATION)
    {
        setTelemetryMode("calibration");
    }
    element("commandState").textContent = `${name}已发送；等待实际遥测状态确认`;
    showToast(`${name}已发送`, "success");
}

function renderLadrcGroups()
{
    const container = element("ladrcGroups");
    container.innerHTML = "";

    LADRC_GROUPS.forEach((group, groupIndex) =>
    {
        const section = document.createElement("section");
        section.className = "ladrc-group";
        section.innerHTML = `
            <div class="ladrc-group-header">
                <strong>${group.name}</strong>
                <span id="ladrcStatus${groupIndex}" class="badge neutral">未读取</span>
            </div>
            <div class="ladrc-inputs">
                <label>b0<input id="ladrc${groupIndex}b0" type="number" min="0.6" max="6553.5" step="0.1" placeholder="--"></label>
                <label>wc<input id="ladrc${groupIndex}wc" type="number" min="0.1" max="${group.wcMax}" step="0.1" placeholder="--"></label>
                <label>wo<input id="ladrc${groupIndex}wo" type="number" min="0.1" max="${group.woMax}" step="0.1" placeholder="--"></label>
            </div>
            <div class="field-hint" style="margin:7px 0 0">dt=${group.dt} s，要求 wo ≥ wc</div>
            <div class="ladrc-group-actions">
                <button data-ladrc-query="${groupIndex}" class="btn-secondary requires-connection" disabled>查询</button>
                <button data-ladrc-apply="${groupIndex}" class="btn-secondary requires-connection" disabled>应用这一组</button>
            </div>`;
        container.appendChild(section);
    });

    container.querySelectorAll("[data-ladrc-query]").forEach(button =>
    {
        button.addEventListener("click", () => runTask(() => runLadrcTask(
            () => queryLadrcGroup(Number(button.dataset.ladrcQuery)))));
    });
    container.querySelectorAll("[data-ladrc-apply]").forEach(button =>
    {
        button.addEventListener("click", () => runTask(() => runLadrcTask(
            () => applyLadrcGroup(Number(button.dataset.ladrcApply)))));
    });
}

function updateLadrcGroup(groupIndex, values)
{
    const statusValue = Math.round(values[4]);
    ladrcCurrentValues[groupIndex] = {
        b0: values[1],
        wc: values[2],
        wo: values[3],
        status: statusValue
    };
    element(`ladrc${groupIndex}b0`).value = values[1].toFixed(1);
    element(`ladrc${groupIndex}wc`).value = values[2].toFixed(1);
    element(`ladrc${groupIndex}wo`).value = values[3].toFixed(1);

    const status = LADRC_STATUS[statusValue] || { text: `未知状态 ${statusValue}`, className: "danger" };
    setBadge(element(`ladrcStatus${groupIndex}`), status.text, status.className);
    setBadge(element("ladrcGlobalStatus"), status.text, status.className);
}

function markerKey(marker)
{
    return String(Math.round(marker));
}

function removeMarkerWaiter(key, waiter)
{
    const queue = markerWaiters.get(key) || [];
    const index = queue.indexOf(waiter);
    if (index >= 0)
    {
        queue.splice(index, 1);
    }
    if (queue.length === 0)
    {
        markerWaiters.delete(key);
    }
}

function createMarkerWaiter(marker, timeoutMs = 1500)
{
    const key = markerKey(marker);
    let waiter = null;
    const promise = new Promise((resolve, reject) =>
    {
        waiter = { resolve, reject, timer: null };
        waiter.timer = window.setTimeout(() =>
        {
            removeMarkerWaiter(key, waiter);
            reject(new Error(`等待下位机回复 ${marker} 超时`));
        }, timeoutMs);

        const queue = markerWaiters.get(key) || [];
        queue.push(waiter);
        markerWaiters.set(key, queue);
    });
    return {
        promise,
        cancel(error)
        {
            window.clearTimeout(waiter.timer);
            removeMarkerWaiter(key, waiter);
            waiter.reject(error);
        }
    };
}

function waitForMarker(marker, timeoutMs = 1500)
{
    return createMarkerWaiter(marker, timeoutMs).promise;
}

function deliverMarker(values)
{
    const key = markerKey(values[0]);
    const queue = markerWaiters.get(key);
    if (!queue || queue.length === 0)
    {
        return;
    }
    const waiter = queue.shift();
    window.clearTimeout(waiter.timer);
    if (queue.length === 0)
    {
        markerWaiters.delete(key);
    }
    waiter.resolve(values);
}

function rejectAllMarkerWaiters(error)
{
    for (const queue of markerWaiters.values())
    {
        for (const waiter of queue)
        {
            window.clearTimeout(waiter.timer);
            waiter.reject(error);
        }
    }
    markerWaiters.clear();
}

async function sendAndWait(command, rawData, aux, marker, timeoutMs = 1500)
{
    const waiter = createMarkerWaiter(marker, timeoutMs);
    try
    {
        await serial.sendCommand(command, rawData, aux);
    }
    catch (error)
    {
        waiter.cancel(error);
        await waiter.promise.catch(() => {});
        throw error;
    }
    return waiter.promise;
}

async function queryLadrcGroup(groupIndex)
{
    const marker = -10000 - groupIndex;
    let lastError = null;

    for (let attempt = 1; attempt <= 3; attempt++)
    {
        try
        {
            const values = await sendAndWait(COMMAND.LADRC_QUERY, 0, groupIndex, marker, 1200);
            if (attempt > 1)
            {
                addLog(`${LADRC_GROUPS[groupIndex].name}第 ${attempt} 次查询成功`, "rx");
            }
            showToast(`${LADRC_GROUPS[groupIndex].name}参数已读取`, "success");
            return values;
        }
        catch (error)
        {
            lastError = error;
            if (attempt < 3)
            {
                addLog(`${LADRC_GROUPS[groupIndex].name}查询无回复，200 ms 后重试 (${attempt}/3)`, "error");
                await new Promise(resolve => window.setTimeout(resolve, 200));
            }
        }
    }

    throw new Error(`${LADRC_GROUPS[groupIndex].name}连续 3 次查询失败：${lastError.message}`);
}

function readLadrcTargets(groupIndex)
{
    const group = LADRC_GROUPS[groupIndex];
    const b0 = readNumberInRange(`ladrc${groupIndex}b0`, 0.6, 6553.5, "b0");
    const wc = readNumberInRange(`ladrc${groupIndex}wc`, 0.1, group.wcMax, "wc");
    const wo = readNumberInRange(`ladrc${groupIndex}wo`, 0.1, group.woMax, "wo");
    if (wo < wc)
    {
        throw new Error("wo 必须大于或等于 wc");
    }
    return {
        b0: Math.round(b0 * 10) / 10,
        wc: Math.round(wc * 10) / 10,
        wo: Math.round(wo * 10) / 10
    };
}

async function setLadrcParameter(groupIndex, itemIndex, value)
{
    const parameterId = groupIndex * 3 + itemIndex;
    const rawData = Math.round(value * 10);
    const marker = -10000 - groupIndex;
    const response = await sendAndWait(COMMAND.LADRC_SET, rawData, parameterId, marker);
    if (Math.round(response[4]) === -1)
    {
        throw new Error(`${LADRC_GROUPS[groupIndex].name}参数被下位机拒绝`);
    }
    return response;
}

async function applyLadrcGroup(groupIndex)
{
    const targets = readLadrcTargets(groupIndex);
    await queryLadrcGroup(groupIndex);
    const current = ladrcCurrentValues[groupIndex];
    if (!current)
    {
        throw new Error("未能读取当前 LADRC 参数");
    }

    const order = [0];
    if (targets.wc > current.wo)
    {
        order.push(2, 1);
    }
    else if (targets.wo < current.wc)
    {
        order.push(1, 2);
    }
    else
    {
        order.push(1, 2);
    }
    const values = [targets.b0, targets.wc, targets.wo];
    for (const itemIndex of order)
    {
        await setLadrcParameter(groupIndex, itemIndex, values[itemIndex]);
    }
    showToast(`${LADRC_GROUPS[groupIndex].name}已写入 RAM`, "success");
}

async function queryAllLadrc()
{
    const failedGroups = [];
    for (let group = 0; group < 4; group++)
    {
        try
        {
            await queryLadrcGroup(group);
        }
        catch (error)
        {
            failedGroups.push(LADRC_GROUPS[group].shortName);
            addLog(error.message, "error");
        }
    }
    if (failedGroups.length > 0)
    {
        throw new Error(`以下环路仍未读到：${failedGroups.join("、")}`);
    }
    showToast("四组 LADRC 参数读取完成", "success");
}

async function saveLadrc()
{
    if (!window.confirm("确认将当前全部 12 个 LADRC 参数写入 Flash？\n请确保电机已经失能。"))
    {
        return;
    }
    const response = await sendAndWait(COMMAND.LADRC_SAVE, 0, 0, -10010, 2500);
    if (Math.round(response[1]) !== 1)
    {
        throw new Error("下位机保存 LADRC 参数失败或拒绝执行");
    }
    setBadge(element("ladrcGlobalStatus"), "RAM 与 Flash 一致", "success");
    document.querySelectorAll("[id^='ladrcStatus']").forEach(status =>
    {
        setBadge(status, "RAM 与 Flash 一致", "success");
    });
    showToast(`LADRC 参数保存成功，Flash 版本 ${Math.round(response[2])}`, "success");
}

async function restoreLadrcDefaults()
{
    if (!window.confirm("确认把四组 LADRC 参数恢复为代码默认值？\n本操作只修改 RAM，仍需点击保存才会写入 Flash。"))
    {
        return;
    }

    const groupWaiters = [0, 1, 2, 3].map(group => createMarkerWaiter(-10000 - group, 2500));
    const failureWaiter = createMarkerWaiter(-10011, 2500);
    const allWaiters = [...groupWaiters, failureWaiter];
    try
    {
        await serial.sendCommand(COMMAND.LADRC_DEFAULTS, 0, 0);
    }
    catch (error)
    {
        allWaiters.forEach(waiter => waiter.cancel(error));
        await Promise.allSettled(allWaiters.map(waiter => waiter.promise));
        throw error;
    }

    let outcome;
    try
    {
        outcome = await Promise.race([
            Promise.all(groupWaiters.map(waiter => waiter.promise)).then(() => "success"),
            failureWaiter.promise.then(() => "rejected")
        ]);
    }
    catch (error)
    {
        allWaiters.forEach(waiter => waiter.cancel(error));
        await Promise.allSettled(allWaiters.map(waiter => waiter.promise));
        throw error;
    }
    if (outcome === "rejected")
    {
        const error = new Error("下位机拒绝恢复 LADRC 默认值");
        groupWaiters.forEach(waiter => waiter.cancel(error));
        await Promise.allSettled(groupWaiters.map(waiter => waiter.promise));
        throw error;
    }
    const completed = new Error("LADRC 默认参数回复已完整接收");
    failureWaiter.cancel(completed);
    await failureWaiter.promise.catch(() => {});
    showToast("已恢复代码默认值，当前尚未保存", "success");
}

function handleLadrcResponse(values)
{
    const marker = Math.round(values[0]);
    if (marker <= -10000 && marker >= -10003)
    {
        const group = -10000 - marker;
        updateLadrcGroup(group, values);
        addLog(`RX LADRC ${LADRC_GROUPS[group].shortName}: b0=${values[1]}, wc=${values[2]}, wo=${values[3]}, status=${Math.round(values[4])}`, "rx");
    }
    else if (marker === -10010)
    {
        addLog(`RX LADRC 保存结果: result=${Math.round(values[1])}, version=${Math.round(values[2])}`, "rx");
    }
    else if (marker === -10011)
    {
        addLog("RX LADRC 恢复默认失败", "error");
        showToast("下位机拒绝恢复 LADRC 默认值", "error");
    }
    else if (marker === -10020)
    {
        addLog(`RX LADRC 参数编号无效: ${Math.round(values[3])}`, "error");
        showToast("LADRC 参数或环路编号无效", "error");
    }
    deliverMarker(values);
}

function isLadrcMarker(value)
{
    const marker = Math.round(value);
    return Math.abs(value - marker) < 0.01 &&
        ((marker <= -10000 && marker >= -10003) || marker === -10010 || marker === -10011 || marker === -10020);
}

serial.onFrame = values =>
{
    element("statFrames").textContent = String(serial.frameCount);
    element("statResync").textContent = String(serial.resyncByteCount);
    element("statInvalid").textContent = String(serial.invalidFrameCount);
    element("statLastRx").textContent = new Date().toLocaleTimeString("zh-CN", { hour12: false });

    if (isLadrcMarker(values[0]))
    {
        handleLadrcResponse(values);
    }
    else
    {
        if (otaApplicationFrameWaiter)
        {
            otaApplicationFrameWaiter.resolve();
        }
        handleOrdinaryTelemetry(values);
    }
};

serial.onTransmit = frame =>
{
    addLog("TX " + FocSerial.toHex(frame), "tx");
};

serial.onConnectionChange = connected =>
{
    updateConnectionUi(connected);
    addLog(connected ? "串口已打开：460800 8N1" : "串口已断开", connected ? "rx" : "info");
};

serial.onError = message =>
{
    addLog(message, "error");
    showToast(message, "error");
};

function waitWithTimeout(promise, timeoutMs, message)
{
    let timeoutId = null;
    return Promise.race([
        promise.finally(() =>
        {
            if (timeoutId !== null) { window.clearTimeout(timeoutId); }
        }),
        new Promise((_, reject) =>
        {
            timeoutId = window.setTimeout(() => reject(new Error(message)), timeoutMs);
        })
    ]);
}

async function toggleConnection()
{
    if (typeof mockGen !== "undefined" && mockGen.isRunning)
    {
        mockGen.stop();
        const btnMockSim = element("btnMockSim");
        if (btnMockSim) btnMockSim.classList.remove("active");
        updateConnectionUi(false);
        addLog("1kHz 仿真演示已停止", "info");
        showToast("仿真演示已停止", "info");
        return;
    }
    const button = element("btnConnect");
    button.disabled = true;
    try
    {
        if (serial.isConnected)
        {
            try
            {
                // Why: 主动断开属于可控路径，应先让电机进入安全状态；物理掉线仍必须依靠下位机看门狗。
                await waitWithTimeout(
                    serial.sendCommand(COMMAND.DISABLE, 0, 0),
                    300,
                    "电机失能命令发送超时"
                );
                setTelemetryMode("standby");
                addLog("主动断开前已发送电机失能命令", "tx");
            }
            catch (error)
            {
                addLog(`主动断开前未能确认失能命令已发送：${error.message}`, "error");
            }
            if (telemetryRequested)
            {
                await waitWithTimeout(
                    serial.sendCommand(COMMAND.TELEMETRY, 0, 0),
                    300,
                    "关闭遥测命令发送超时"
                ).catch(() => {});
            }
            await serial.disconnect();
        }
        else
        {
            await serial.connect();
        }
    }
    finally
    {
        button.disabled = false;
    }
}

async function runTask(task)
{
    try
    {
        await task();
    }
    catch (error)
    {
        addLog(error.message, "error");
        showToast(error.message, "error");
    }
}

async function runLadrcTask(task)
{
    if (ladrcTaskBusy)
    {
        throw new Error("已有 LADRC 操作正在执行，请等待当前操作完成");
    }
    ladrcTaskBusy = true;
    try
    {
        return await task();
    }
    finally
    {
        ladrcTaskBusy = false;
    }
}

function bindEvents()
{
    element("btnConnect").addEventListener("click", () => runTask(toggleConnection));

    element("speedMode").addEventListener("change", updateSpeedModeInput);
    element("stepMode").addEventListener("change", updateStepModeInput);
    updateSpeedModeInput();
    updateStepModeInput();

    element("btnTelemetryStart").addEventListener("click", () => runTask(async () =>
    {
        await serial.sendCommand(COMMAND.TELEMETRY, 1, 0);
        telemetryRequested = true;
        setBadge(element("telemetryBadge"), "等待设备上报", "warning");
        showToast("连续遥测开启命令已发送", "success");
    }));

    element("btnTelemetryStop").addEventListener("click", () => runTask(async () =>
    {
        await serial.sendCommand(COMMAND.TELEMETRY, 0, 0);
        telemetryRequested = false;
        setBadge(element("telemetryBadge"), "等待设备停止", "warning");
        showToast("连续遥测关闭命令已发送", "success");
    }));

    element("telemetryMode").addEventListener("change", event =>
    {
        if (event.target.value === "auto")
        {
            inferAutomaticModeFromRate(lastMeasuredTelemetryRate);
            if (lastMeasuredTelemetryRate <= 0)
            {
                applyTelemetrySchema(resolvedTelemetryMode, "等待新的遥测帧复核");
            }
        }
        else
        {
            applyTelemetrySchema(event.target.value, "手动选择");
        }
    });
    element("btnEnable").addEventListener("click", () => runTask(() => sendControl(COMMAND.ENABLE, 0, "电机使能")));
    element("btnDisable").addEventListener("click", () => runTask(() => sendControl(COMMAND.DISABLE, 0, "电机立即失能")));

    document.querySelectorAll("[data-motion]").forEach(button =>
    {
        button.addEventListener("click", () => runTask(async () =>
        {
            const type = button.dataset.motion;
            if (type === "current")
            {
                const value = readNumberInRange("inputCurrent", -1.5, 1.5, "Iq 电流");
                // 下位机协议仍以 ±10A 为满量程，界面只把可操作范围收紧到功率级安全值 ±1.5A。
                await sendControl(COMMAND.CURRENT, signedPhysicalToRaw(value, 10), `目标电流 ${value} A`);
            }
            else if (type === "speed")
            {
                const isLowSpeedTorque = element("speedMode").value === "lowSpeedTorque";
                const limit = isLowSpeedTorque ? 2 : 100;
                const value = readNumberInRange("inputSpeed", -limit, limit,
                    isLowSpeedTorque ? "低速大力矩速度" : "普通目标速度");
                await sendControl(
                    isLowSpeedTorque ? COMMAND.LOW_SPEED_TORQUE : COMMAND.SPEED,
                    signedPhysicalToRaw(value, limit),
                    `${isLowSpeedTorque ? "低速大力矩" : "普通速度"} ${value} Hz`
                );
            }
            else if (type === "position")
            {
                const value = readNumberInRange("inputPosition", -10, 10, "绝对位置");
                await sendControl(COMMAND.POSITION, signedPhysicalToRaw(value, 10), `绝对位置 ${value} 圈`);
            }
            else if (type === "step")
            {
                const isDirectStep = element("stepMode").value === "directStep";
                const value = readNumberInRange("inputStep", -2, 2,
                    isDirectStep ? "直接位置阶跃" : "梯形相对步进");
                await sendControl(
                    isDirectStep ? COMMAND.DIRECT_STEP : COMMAND.STEP,
                    signedPhysicalToRaw(value, 2),
                    `${isDirectStep ? "直接位置阶跃" : "梯形相对步进"} ${value} 圈`
                );
            }
        }));
    });

    element("btnSetMotorId").addEventListener("click", () => runTask(async () =>
    {
        const motorId = readNumberInRange("inputMotorId", 0, 9, "Motor ID");
        if (!Number.isInteger(motorId))
        {
            throw new Error("Motor ID 必须是 0～9 的整数");
        }
        if (window.confirm(`确认把 Motor ID 设置为 ${motorId} 并写入 Flash？`))
        {
            await sendControl(COMMAND.MOTOR_ID, motorId, `Motor ID ${motorId}`);
            element("motorIdReadbackHint").textContent = "设置命令已发送，等待待机遥测确认";
        }
    }));

    element("btnClearElectricalZero").addEventListener("click", () => runTask(async () =>
    {
        if (window.confirm("确认擦除电气零点？\n设备重新启动后需要重新执行电气零点标定。"))
        {
            await sendControl(COMMAND.CLEAR_ELECTRICAL_ZERO, 0, "擦除电气零点");
        }
    }));

    element("btnEncoderCalibration").addEventListener("click", () => runTask(async () =>
    {
        if (window.confirm("确认启动 MT6826 自校准？\n请确保电机失能、机构可以安全转动。"))
        {
            await sendControl(COMMAND.ENCODER_CALIBRATION, 0, "MT6826 自校准");
        }
    }));

    element("btnSetTempZero").addEventListener("click", () => runTask(async () =>
    {
        if (window.confirm("确认把当前位置设为临时业务零点？\n该设置仅在本次上电期间有效。"))
        {
            await sendControl(COMMAND.TEMP_ZERO, 0, "临时业务零点");
        }
    }));

    element("btnSaveZero").addEventListener("click", () => runTask(async () =>
    {
        if (window.confirm("确认把当前位置保存为永久业务零点？\n该操作会写入 Flash。"))
        {
            await sendControl(COMMAND.SAVE_ZERO, 0, "永久业务零点");
        }
    }));

    element("btnQueryAll").addEventListener("click", () => runTask(() => runLadrcTask(queryAllLadrc)));
    element("btnSaveLadrc").addEventListener("click", () => runTask(() => runLadrcTask(saveLadrc)));
    element("btnRestoreLadrc").addEventListener("click", () => runTask(() => runLadrcTask(restoreLadrcDefaults)));

    element("btnPausePlot").addEventListener("click", () =>
    {
        plot.setPaused(!plot.paused);
    });
    element("btnClearMarkers")?.addEventListener("click", () =>
    {
        plot.clearMarkers();
        showToast("已清除测量游标", "info");
    });
    element("btnClearPlot").addEventListener("click", () => plot.clear());
    element("btnExportCsv").addEventListener("click", () => runTask(async () => plot.exportCsv()));
    element("autoScale").addEventListener("change", event => plot.setAutoScale(event.target.checked));
    element("xAuto").addEventListener("change", event => plot.setXAuto(event.target.checked));
    element("selectPlotFps")?.addEventListener("change", event => plot.setTargetFps(Number(event.target.value) || 60));
    const applyXBounds = () => plot.setViewBounds(
        Number(element("plotXStart").value),
        Number(element("plotXEnd").value)
    );
    element("plotXStart").addEventListener("change", applyXBounds);
    element("plotXEnd").addEventListener("change", applyXBounds);
    element("btnClearLog").addEventListener("click", () => { element("logOutput").innerHTML = ""; });

    const btnMockSim = element("btnMockSim");
    if (btnMockSim)
    {
        btnMockSim.addEventListener("click", () =>
        {
            if (mockGen.isRunning)
            {
                mockGen.stop();
                btnMockSim.classList.remove("active");
                updateConnectionUi(false);
                addLog("1kHz 仿真演示已停止", "info");
                showToast("仿真演示已停止", "info");
            }
            else
            {
                if (serial.isConnected)
                {
                    showToast("物理串口已连接，请先断开串口再开启仿真", "warning");
                    return;
                }
                mockGen.start();
                btnMockSim.classList.add("active");
                updateConnectionUi(true);
                element("connectionText").textContent = "仿真中 (1kHz)";
                element("connectionIndicator").className = "status-dot online";
                setTelemetryMode("run");
                addLog("已开启 1kHz FOC 全真信号仿真演示", "rx");
                showToast("1kHz 仿真演示运行中", "success");
            }
        });
    }
}

class MockTelemetryGenerator
{
    constructor(onFrameCallback)
    {
        this.onFrame = onFrameCallback;
        this.timer = null;
        this.isRunning = false;
        this.simTime = 0;
        this.stepTimer = 0;
        this.targetSpeed = 20.0;
        this.actualSpeed = 0.0;
        this.speedVelocity = 0.0;
        this.angle = 0.0;
    }

    start()
    {
        if (this.isRunning) { return; }
        this.isRunning = true;
        this.simTime = 0;
        this.stepTimer = 0;
        this.targetSpeed = 20.0;
        this.actualSpeed = 0.0;
        this.speedVelocity = 0.0;
        this.angle = 0.0;

        this.timer = window.setInterval(() =>
        {
            if (!this.isRunning) { return; }
            for (let i = 0; i < 10; i++)
            {
                this.stepSim(0.001);
            }
        }, 10);
    }

    stop()
    {
        this.isRunning = false;
        if (this.timer)
        {
            window.clearInterval(this.timer);
            this.timer = null;
        }
    }

    stepSim(dt)
    {
        this.simTime += dt;
        this.stepTimer += dt;

        if (this.stepTimer > 3.0)
        {
            this.stepTimer = 0;
            const steps = [20.0, 55.0, 15.0, 75.0, 30.0];
            const nextIdx = Math.floor((this.simTime / 3.0) % steps.length);
            this.targetSpeed = steps[nextIdx];
        }

        const wn = 28.0;
        const zeta = 0.42;
        const speedErr = this.targetSpeed - this.actualSpeed;
        const accel = wn * wn * speedErr - 2.0 * zeta * wn * this.speedVelocity;
        this.speedVelocity += accel * dt;
        this.actualSpeed += this.speedVelocity * dt;

        const iqTarget = Math.max(-1.5, Math.min(1.5, this.speedVelocity * 0.045));
        const noise = (Math.random() - 0.5) * 0.04;
        const ripple = Math.sin(this.simTime * 2 * Math.PI * 150) * 0.03;
        const iqActual = iqTarget + ripple + noise;

        this.angle = (this.angle + this.actualSpeed * 360 * dt) % 360;
        if (this.angle < 0) { this.angle += 360; }

        const values = [
            this.targetSpeed,
            this.actualSpeed,
            iqTarget,
            iqActual,
            this.angle
        ];

        this.onFrame(values);
    }
}

const mockGen = new MockTelemetryGenerator(values =>
{
    handleOrdinaryTelemetry(values);
});

window.setInterval(() =>
{
    const now = performance.now();
    const elapsed = Math.max(0.001, (now - frameWindowStart) / 1000);
    const measuredRate = Math.round(frameWindowCount / elapsed);
    lastMeasuredTelemetryRate = measuredRate;
    element("statRate").textContent = `${measuredRate} Hz`;
    element("statResync").textContent = String(serial.resyncByteCount);
    element("statInvalid").textContent = String(serial.invalidFrameCount);
    inferAutomaticModeFromRate(measuredRate);

    if (lastOrdinaryTelemetryAt > 0)
    {
        const silenceLimit = resolvedTelemetryMode === "standby" ? 2500 : 500;
        if ((now - lastOrdinaryTelemetryAt) > silenceLimit)
        {
            telemetryRequested = false;
            setBadge(element("telemetryBadge"), "未检测到上报", "neutral");
        }
    }
    frameWindowCount = 0;
    frameWindowStart = now;
}, 1000);

// ==========================================================================
// OTA 固件升级交互控制器
// ==========================================================================
const otaEngine = new FocOtaEngine(serial);
let currentFirmwareBuffer = null;

// 接管串口原始数据流至 OTA 引擎
serial.onRawData = chunk =>
{
    if (otaEngine && otaEngine.isRunning)
    {
        otaEngine.feedRawBytes(chunk);
    }
};

function addOtaLog(message, type = "info")
{
    const consoleEl = element("otaLogConsole");
    if (!consoleEl) { return; }
    const entry = document.createElement("div");
    entry.className = `log-entry log-${type}`;
    entry.textContent = message;
    consoleEl.appendChild(entry);
    consoleEl.scrollTop = consoleEl.scrollHeight;
}

function updateOtaStepIndicator(state)
{
    const stepIds = ["stepTrigger", "stepHandshake", "stepErase", "stepData", "stepVerify", "stepComplete"];
    stepIds.forEach(id =>
    {
        const el = element(id);
        if (el) { el.className = "step-item"; }
    });

    const setStepState = (activeId, doneIds = []) =>
    {
        doneIds.forEach(id => element(id)?.classList.add("done"));
        element(activeId)?.classList.add("active");
    };

    switch (state)
    {
        case "TRIGGERING":
            setStepState("stepTrigger");
            break;
        case "HANDSHAKE":
            setStepState("stepHandshake", ["stepTrigger"]);
            break;
        case "ERASING":
            setStepState("stepErase", ["stepTrigger", "stepHandshake"]);
            break;
        case "TRANSFERRING":
            setStepState("stepData", ["stepTrigger", "stepHandshake", "stepErase"]);
            break;
        case "VERIFYING":
            setStepState("stepVerify", ["stepTrigger", "stepHandshake", "stepErase", "stepData"]);
            break;
        case "RESTARTING":
            setStepState("stepComplete", ["stepTrigger", "stepHandshake", "stepErase", "stepData", "stepVerify"]);
            break;
        case "SUCCESS":
            stepIds.forEach(id => element(id)?.classList.add("done"));
            break;
        default:
            break;
    }
}

function initOtaUi()
{
    const modal = element("otaModal");
    const btnOpen = element("btnOpenOtaModal");
    const btnClose = element("btnCloseOtaModal");
    const tabPreset = element("tabPresetFirmware");
    const tabCustom = element("tabCustomFirmware");
    const sectionPreset = element("otaPresetSection");
    const sectionUpload = element("otaUploadSection");
    const selectPreset = element("selectPresetFirmware");
    const presetDesc = element("presetDesc");
    const dropZone = element("otaDropZone");
    const fileInput = element("otaFileInput");
    const btnStart = element("btnStartOta");
    const btnAbort = element("btnAbortOta");
    const btnClearLog = element("btnClearOtaLog");

    const updateOtaButtons = () =>
    {
        // Why: 串口未连接时保留点击能力以显示原因；仅固件未就绪或升级运行中禁止开始。
        btnStart.disabled = !currentFirmwareBuffer || otaEngine.isRunning;
        btnAbort.disabled = !otaEngine.isRunning;
        modal.classList.toggle("ota-busy", otaEngine.isRunning);
    };

    const clearFirmwareSelection = () =>
    {
        currentFirmwareBuffer = null;
        element("otaFileName").textContent = "--";
        element("otaFileSize").textContent = "--";
        element("otaFileCrc").textContent = "--";
        updateOtaButtons();
    };

    const acceptFirmware = (arrayBuffer, name) =>
    {
        const vector = otaEngine.validateFirmware(arrayBuffer);
        const bytes = new Uint8Array(arrayBuffer);
        const crc32 = otaEngine.computeCrc32(bytes);
        currentFirmwareBuffer = arrayBuffer;
        element("otaFileName").textContent = name;
        element("otaFileSize").textContent = `${(bytes.length / 1024).toFixed(2)} KB (${bytes.length} 字节)`;
        element("otaFileCrc").textContent = `0x${crc32.toString(16).toUpperCase().padStart(8, "0")}`;
        updateOtaButtons();
        addOtaLog(`[固件校验通过] ${name}，Reset Handler 0x${vector.resetEntry.toString(16).toUpperCase().padStart(8, "0")}`, "success");
    };

    // 初始化预置固件列表
    const presets = window.PRESET_FIRMWARES || [];
    if (selectPreset)
    {
        selectPreset.innerHTML = "";
        presets.forEach((item, idx) =>
        {
            const opt = document.createElement("option");
            opt.value = String(idx);
            opt.textContent = `${item.name} · ${item.version}`;
            if (item.isDefault) { opt.selected = true; }
            selectPreset.appendChild(opt);
        });

        const loadSelectedPreset = async () =>
        {
            const selected = presets[Number(selectPreset.value) || 0];
            clearFirmwareSelection();
            if (!selected) { return; }
            presetDesc.textContent = selected.desc;

            // 优先直接使用零依赖内嵌 Base64 数据解码
            const embeddedBase64 = selected.base64 || (selected.dataVariable ? window[selected.dataVariable] : "");
            if (embeddedBase64)
            {
                try
                {
                    const binaryStr = atob(embeddedBase64);
                    const bytes = new Uint8Array(binaryStr.length);
                    for (let i = 0; i < binaryStr.length; i++)
                    {
                        bytes[i] = binaryStr.charCodeAt(i);
                    }
                    acceptFirmware(bytes.buffer, selected.name);
                    return;
                }
                catch (err)
                {
                    clearFirmwareSelection();
                    addOtaLog(`[预置固件无效] ${err.message}`, "error");
                    return;
                }
            }

            try
            {
                const res = await fetch(selected.path);
                if (res.ok)
                {
                    acceptFirmware(await res.arrayBuffer(), selected.name);
                }
                else
                {
                    throw new Error("HTTP " + res.status);
                }
            }
            catch (err)
            {
                clearFirmwareSelection();
                addOtaLog(`[预置固件读取失败] ${err.message}`, "error");
            }
        };

        selectPreset.addEventListener("change", loadSelectedPreset);
        loadSelectedPreset();
    }

    // Tab 切换
    if (tabPreset && tabCustom)
    {
        tabPreset.addEventListener("click", () =>
        {
            tabPreset.classList.add("active");
            tabCustom.classList.remove("active");
            sectionPreset.style.display = "flex";
            sectionUpload.style.display = "none";
            if (selectPreset) { selectPreset.dispatchEvent(new Event("change")); }
        });

        tabCustom.addEventListener("click", () =>
        {
            tabCustom.classList.add("active");
            tabPreset.classList.remove("active");
            sectionPreset.style.display = "none";
            sectionUpload.style.display = "block";
            clearFirmwareSelection();
            fileInput.value = "";
        });
    }

    const closeModalSafe = () =>
    {
        if (otaEngine.isRunning)
        {
            showToast("升级进行中，请先点击中止升级", "warning");
            return;
        }
        modal.style.display = "none";
    };

    if (btnOpen)
    {
        btnOpen.addEventListener("click", () =>
        {
            modal.style.display = "flex";
        });
    }

    if (btnClose)
    {
        btnClose.addEventListener("click", closeModalSafe);
    }

    if (modal)
    {
        modal.addEventListener("click", e =>
        {
            if (e.target === modal)
            {
                closeModalSafe();
            }
        });
    }

    window.addEventListener("keydown", e =>
    {
        if (e.key === "Escape" && modal && modal.style.display !== "none")
        {
            closeModalSafe();
        }
    });

    if (btnClearLog)
    {
        btnClearLog.addEventListener("click", () =>
        {
            const consoleEl = element("otaLogConsole");
            if (consoleEl) { consoleEl.innerHTML = ""; }
        });
    }

    // 拖拽与本地文件选择
    if (dropZone && fileInput)
    {
        dropZone.addEventListener("click", () => fileInput.click());
        dropZone.addEventListener("dragover", e => { e.preventDefault(); dropZone.classList.add("dragover"); });
        dropZone.addEventListener("dragleave", () => dropZone.classList.remove("dragover"));
        dropZone.addEventListener("drop", e =>
        {
            e.preventDefault();
            dropZone.classList.remove("dragover");
            if (e.dataTransfer.files && e.dataTransfer.files.length > 0)
            {
                handleFirmwareFile(e.dataTransfer.files[0]);
            }
        });
        fileInput.addEventListener("change", e =>
        {
            if (e.target.files && e.target.files.length > 0)
            {
                handleFirmwareFile(e.target.files[0]);
            }
        });
    }

    function handleFirmwareFile(file)
    {
        if (!file.name.toLowerCase().endsWith(".bin"))
        {
            clearFirmwareSelection();
            showToast("请选择 MSPM0 G3507 Application 二进制固件 (.bin)", "warning");
            return;
        }

        const reader = new FileReader();
        reader.onload = () =>
        {
            try
            {
                acceptFirmware(reader.result, file.name);
            }
            catch (err)
            {
                clearFirmwareSelection();
                addOtaLog(`[固件无效] ${err.message}`, "error");
                showToast(`固件校验失败：${err.message}`, "danger");
            }
        };
        reader.onerror = () =>
        {
            clearFirmwareSelection();
            showToast("固件文件读取失败", "danger");
        };
        reader.readAsArrayBuffer(file);
    }

    // OTA 引擎事件绑定
    otaEngine.onLog = (msg, level) =>
    {
        addOtaLog(msg, level);
    };

    otaEngine.onStateChange = (state, percent) =>
    {
        updateOtaStepIndicator(state);
        element("otaProgressBar").style.width = `${percent}%`;
        element("otaPercentText").textContent = `${percent}%`;
    };

    otaEngine.onProgress = ({ percent, sentBytes, totalBytes, speedKbps }) =>
    {
        element("otaProgressBar").style.width = `${percent}%`;
        element("otaPercentText").textContent = `${percent}%`;
        element("otaSpeedText").textContent = `${speedKbps} KB/s`;
        element("otaBytesText").textContent = `${sentBytes} / ${totalBytes} B`;
    };

    otaEngine.onVerifyApplication = () => new Promise((resolve, reject) =>
    {
        let finished = false;
        let probeTimer = null;
        let timeoutTimer = null;

        const finish = error =>
        {
            if (finished) { return; }
            finished = true;
            window.clearInterval(probeTimer);
            window.clearTimeout(timeoutTimer);
            otaApplicationFrameWaiter = null;
            if (error) { reject(error); }
            else
            {
                telemetryRequested = true;
                resolve();
            }
        };

        otaApplicationFrameWaiter = {
            resolve: () => finish(null),
            reject: error => finish(error)
        };

        const sendProbe = () =>
        {
            if (otaEngine.abortRequested)
            {
                finish(new Error("升级已中止"));
                return;
            }
            serial.sendCommand(COMMAND.TELEMETRY, 1, 0).catch(() => {});
        };

        // Why: APP 刚复位时首条命令可能到得过早，短周期重发可覆盖启动窗口且不改下位机协议。
        probeTimer = window.setInterval(sendProbe, 350);
        timeoutTimer = window.setTimeout(() =>
        {
            finish(new Error("新 Application 启动确认超时，未收到合法 JustFloat 遥测"));
        }, 6000);
        window.setTimeout(sendProbe, 250);
    });

    otaEngine.onAbort = () =>
    {
        otaApplicationFrameWaiter?.reject(new Error("升级已中止"));
    };

    otaEngine.onComplete = () =>
    {
        btnAbort.disabled = true;
        showToast("🎉 固件 OTA 升级成功完成！", "success");
    };

    otaEngine.onError = err =>
    {
        btnAbort.disabled = true;
        showToast(`OTA 升级失败: ${err.message}`, "danger");
    };

    if (btnStart)
    {
        btnStart.addEventListener("click", async () =>
        {
            if (!currentFirmwareBuffer)
            {
                const message = "请先选择并完成 .bin 固件校验";
                showToast(message, "warning");
                addOtaLog(`[无法开始] ${message}`, "warning");
                return;
            }
            if (!serial.isConnected)
            {
                const message = "请先连接电机串口 (460800 baud)，再开始 OTA 升级";
                showToast(message, "warning");
                addOtaLog(`[无法开始] ${message}`, "warning");
                return;
            }
            if (otaEngine.isRunning)
            {
                const message = "OTA 升级已在进行中";
                showToast(message, "warning");
                addOtaLog(`[无法开始] ${message}`, "warning");
                return;
            }

            btnStart.disabled = true;
            btnAbort.disabled = false;
            addOtaLog("=== 开始执行 OTA 固件升级全流程 ===", "info");

            try
            {
                const upgrade = otaEngine.startUpgrade(currentFirmwareBuffer);
                updateOtaButtons();
                await upgrade;
            }
            catch (e)
            {
                addOtaLog(`升级异常: ${e.message}`, "error");
            }
            finally
            {
                updateOtaButtons();
            }
        });
    }

    if (btnAbort)
    {
        btnAbort.addEventListener("click", () =>
        {
            otaEngine.abort();
            btnAbort.disabled = true;
        });
    }

    updateOtaButtons();
}

initOtaUi();

renderLadrcGroups();
bindEvents();
updateConnectionUi(false);
addLog("上位机已就绪，请使用 Chrome 或 Edge 连接串口");

if (new URLSearchParams(window.location.search).get("mock") === "1")
{
    const btn = element("btnMockSim");
    if (btn)
    {
        btn.click();
    }
}
