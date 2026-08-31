"use strict";

/**
 * Universal Web Plotter · 现代化通用串口示波器核心控制器
 * 包含 FireWater / JustFloat 两种通道打印、VOFA+ 双游标差值测量与卡片内 3D 姿态解算就地切换
 */

const serial = new UniversalSerialEngine();
const plotter = new UniversalPlotter(
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

// 3D 姿态正方体渲染器
let cubeRenderer = null;
try
{
    const cubeCanvas = document.getElementById("imuCanvas");
    if (cubeCanvas && window.ImuCubeRenderer)
    {
        cubeRenderer = new window.ImuCubeRenderer(cubeCanvas);
    }
}
catch (err)
{
    console.warn("3D 渲染器初始化:", err.message);
}

plotter.onAutoScaleChange = enabled =>
{
    const el = document.getElementById("autoScale");
    if (el) { el.checked = enabled; }
};

plotter.onPausedChange = paused =>
{
    const btn = document.getElementById("btnPausePlot");
    if (btn)
    {
        btn.querySelector("span").textContent = paused ? "继续曲线" : "暂停曲线";
    }
};

plotter.onXViewChange = state =>
{
    const xAutoEl = document.getElementById("xAuto");
    if (xAutoEl) { xAutoEl.checked = state.xAuto; }

    const xDivEl = document.getElementById("plotXDiv");
    if (xDivEl) { xDivEl.textContent = `${plotter.formatTime(state.xPerDivMs)}/X-div`; }

    const startInput = document.getElementById("plotXStart");
    const endInput = document.getElementById("plotXEnd");
    if (startInput && document.activeElement !== startInput)
    {
        startInput.value = String(Number(state.startMs.toFixed(3)));
    }
    if (endInput && document.activeElement !== endInput)
    {
        endInput.value = String(Number(state.endMs.toFixed(3)));
    }
};

let frameWindowCount = 0;
let frameWindowStart = performance.now();
let lastMeasuredRate = 0;
let smoothedSampleRate = 0;
let lastCubeUpdate = 0;
let terminalTextDecoder = new TextDecoder("utf-8", { fatal: false });

function el(id)
{
    return document.getElementById(id);
}

function addLog(msg, type = "info")
{
    const out = el("terminalOutput");
    if (!out) { return; }
    const line = document.createElement("div");
    line.className = `log-line ${type}`;
    line.textContent = `[${new Date().toLocaleTimeString("zh-CN", { hour12: false })}] ${msg}`;
    out.appendChild(line);
    while (out.children.length > 300)
    {
        out.firstElementChild.remove();
    }
    const autoScroll = el("chkAutoScroll") ? el("chkAutoScroll").checked : true;
    if (autoScroll)
    {
        out.scrollTop = out.scrollHeight;
    }
}

function showToast(message, type = "info")
{
    const container = el("toastContainer");
    if (!container) { return; }
    const toast = document.createElement("div");
    toast.className = `toast ${type}`;
    toast.textContent = message;
    container.appendChild(toast);
    window.setTimeout(() => toast.remove(), 3200);
}

function updateConnectionUi(connected)
{
    const btn = el("btnConnect");
    const dot = el("connectionIndicator");
    const txt = el("connectionText");

    if (dot) { dot.className = `status-dot ${connected ? "online" : "offline"}`; }
    if (txt) { txt.textContent = connected ? `已连接 (${serial.baudRate})` : "未连接"; }

    if (btn)
    {
        if (connected)
        {
            btn.className = "btn-connect-ready connected";
            btn.innerHTML = `
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
                    <line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line>
                </svg>
                <span>断开串口</span>`;
        }
        else
        {
            btn.className = "btn-connect-ready";
            btn.innerHTML = `
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
                    <path d="M5 12h14"></path><path d="M12 5l7 7-7 7"></path>
                </svg>
                <span>连接串口</span>`;
        }
    }

    document.querySelectorAll(".requires-connection").forEach(b =>
    {
        b.disabled = !connected;
    });
}

// 统一数据帧接收与分发中心 (波形数据记录 + 3D 姿态正方体旋转驱动)
function handleFrameReceived(values)
{
    plotter.addSample(values);
    frameWindowCount++;
    el("statFrames").textContent = String(serial.frameCount);
    el("statChannels").textContent = String(values.length);

    // 驱动 3D 姿态正方体旋转
    if (cubeRenderer)
    {
        const rIdx = Number(el("selectMapRoll")?.value || 0);
        const pIdx = Number(el("selectMapPitch")?.value || 1);
        const yIdx = Number(el("selectMapYaw")?.value || 2);

        const roll = (rIdx < values.length && Number.isFinite(values[rIdx])) ? values[rIdx] : 0;
        const pitch = (pIdx < values.length && Number.isFinite(values[pIdx])) ? values[pIdx] : 0;
        const yaw = (yIdx < values.length && Number.isFinite(values[yIdx])) ? values[yIdx] : 0;

        cubeRenderer.setPoseEuler(roll, pitch, yaw);

        // 节流更新 3D 角度徽章
        const now = performance.now();
        if (now - lastCubeUpdate > 50)
        {
            lastCubeUpdate = now;
            if (el("cubeValRoll")) { el("cubeValRoll").textContent = `${roll.toFixed(2)}°`; }
            if (el("cubeValPitch")) { el("cubeValPitch").textContent = `${pitch.toFixed(2)}°`; }
            if (el("cubeValYaw")) { el("cubeValYaw").textContent = `${yaw.toFixed(2)}°`; }
        }
    }
}

serial.onFrame = values =>
{
    handleFrameReceived(values);
};

serial.onRawData = bytes =>
{
    el("statBytes").textContent = `${serial.byteCount} bytes`;
    const rxMode = el("terminalRxMode") ? el("terminalRxMode").value : "ascii";
    if (rxMode === "hex")
    {
        const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, "0").toUpperCase()).join(" ");
        addLog(hex, "rx");
    }
    else if (serial.protocol !== "justfloat")
    {
        // Why: JustFloat 是二进制流，ASCII 模式下隐藏乱码；需要查看原始字节时切换到HEX。
        const text = terminalTextDecoder.decode(bytes, { stream: true });
        if (text.length > 0)
        {
            addLog(text.replace(/[\r\n]+$/, ""), "rx");
        }
    }
};

serial.onConnectionChange = connected =>
{
    updateConnectionUi(connected);
    if (connected)
    {
        terminalTextDecoder = new TextDecoder("utf-8", { fatal: false });
        smoothedSampleRate = 0;
        frameWindowCount = 0;
        frameWindowStart = performance.now();
        addLog(`串口已打开 [${serial.baudRate} 8-N-1], 协议: ${serial.protocol}`, "info");
        showToast("串口连接成功", "success");
    }
    else
    {
        addLog("串口已关闭", "warning");
        showToast("串口已断开", "info");
    }
};

serial.onError = error =>
{
    const message = error instanceof Error ? error.message : String(error);
    addLog(`错误: ${message}`, "error");
    showToast(message, "error");
};

async function toggleConnection()
{
    if (serial.isConnected)
    {
        await serial.disconnect();
    }
    else
    {
        const baud = Number(el("selectBaudRate").value) || 115200;
        const proto = el("selectProtocol").value;
        serial.setProtocol(proto);
        try
        {
            await serial.connect(baud);
        }
        catch (err)
        {
            addLog(`错误: ${err.message}`, "error");
            showToast(err.message, "error");
        }
    }
}

// 1kHz 全真 4 通道多波形仿真发生器 (复合姿态与阶跃波)
class UniversalMockGenerator
{
    constructor(onFrameCallback)
    {
        this.onFrame = onFrameCallback;
        this.timer = null;
        this.isRunning = false;
        this.simTime = 0;
    }

    start()
    {
        if (this.isRunning) { return; }
        this.isRunning = true;
        this.simTime = 0;

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
        const t = this.simTime;

        // CH1: Roll 翻滚角 (±45° 正弦复合摆动)
        const ch1 = Math.sin(t * 2.5) * 45.0 + Math.sin(t * 7.5) * 5.0;
        // CH2: Pitch 俯仰角 (±35° 余弦周期)
        const ch2 = Math.cos(t * 1.8) * 35.0;
        // CH3: Yaw 偏航角 (30°/s 连续旋转)
        const ch3 = (t * 30.0) % 360.0 - 180.0;
        // CH4: 随机高斯噪声 + 阶跃
        const noise = (Math.random() - 0.5) * 8;
        const step = Math.floor(t / 2) % 2 === 0 ? 30 : 70;
        const ch4 = step + noise;

        this.onFrame([ch1, ch2, ch3, ch4]);
    }
}

const mockGen = new UniversalMockGenerator(values =>
{
    serial.frameCount++;
    handleFrameReceived(values);
});

// 卡片内就地视图切换 (动态波形 vs 3D 姿态，3D 模式自动隐藏无关时间轴与波形图例以防溢出)
function switchStageMode(mode)
{
    const plotCanvas = el("plotCanvas");
    const imuCanvas = el("imuCanvas");
    const cubeOverlay = el("cubeOverlayBar");
    const btnPlot = el("btnModePlot");
    const btnCube = el("btnModeCube");
    const plotOverview = el("plotOverview");
    const plotXControls = document.querySelector(".plot-x-controls");
    const channelLegend = document.querySelector(".channel-legend");

    if (mode === "cube")
    {
        if (plotCanvas) { plotCanvas.style.display = "none"; }
        if (imuCanvas) { imuCanvas.style.display = "block"; }
        if (cubeOverlay) { cubeOverlay.style.display = "flex"; }
        if (plotOverview) { plotOverview.style.display = "none"; }
        if (plotXControls) { plotXControls.style.display = "none"; }
        if (channelLegend) { channelLegend.style.display = "none"; }
        btnPlot?.classList.remove("active");
        btnCube?.classList.add("active");
        setTimeout(() => { if (cubeRenderer) { cubeRenderer.resize(); } }, 30);
    }
    else
    {
        if (imuCanvas) { imuCanvas.style.display = "none"; }
        if (cubeOverlay) { cubeOverlay.style.display = "none"; }
        if (plotCanvas) { plotCanvas.style.display = "block"; }
        if (plotOverview) { plotOverview.style.display = "block"; }
        if (plotXControls) { plotXControls.style.display = "flex"; }
        if (channelLegend) { channelLegend.style.display = "flex"; }
        btnCube?.classList.remove("active");
        btnPlot?.classList.add("active");
        setTimeout(() => { plotter.resize(); }, 30);
    }
}

function bindEvents()
{
    el("btnConnect").addEventListener("click", toggleConnection);

    el("selectProtocol").addEventListener("change", e =>
    {
        serial.setProtocol(e.target.value);
        localStorage.setItem("plotter_protocol", e.target.value);
        addLog(`已切换数据解析引擎为: ${e.target.options[e.target.selectedIndex].text}`, "info");
        showToast(`已切换协议为: ${e.target.options[e.target.selectedIndex].text}`, "success");
    });

    el("btnPausePlot").addEventListener("click", () =>
    {
        plotter.setPaused(!plotter.paused);
    });

    if (el("btnClearMarkers"))
    {
        el("btnClearMarkers").addEventListener("click", () =>
        {
            plotter.clearMarkers();
            showToast("已清除测量游标", "info");
        });
    }

    el("btnClearPlot").addEventListener("click", () => plotter.clear());
    el("btnExportCsv").addEventListener("click", () =>
    {
        try { plotter.exportCsv(); }
        catch (err) { showToast(err.message, "warning"); }
    });

    el("autoScale").addEventListener("change", e => plotter.setAutoScale(e.target.checked));
    el("xAuto").addEventListener("change", e => plotter.setXAuto(e.target.checked));

    const applyXBounds = () => plotter.setViewBounds(
        Number(el("plotXStart").value),
        Number(el("plotXEnd").value)
    );
    el("plotXStart").addEventListener("change", applyXBounds);
    el("plotXEnd").addEventListener("change", applyXBounds);

    el("selectFps").addEventListener("change", e =>
    {
        const fps = Number(e.target.value);
        plotter.setTargetFps(fps);
        localStorage.setItem("plotter_fps", String(fps));
        showToast(`已切换渲染帧率为: ${fps} FPS`, "info");
    });

    el("selectChannelMode")?.addEventListener("change", e =>
    {
        const count = Number(e.target.value) || 0;
        serial.setChannelCount(count);
        if (count > 0)
        {
            plotter.ensureChannelCapacity(count);
            showToast(`已锁定通道数为: ${count} 通道 (严格防错位)`, "success");
        }
        else
        {
            showToast("已开启自动稳态通道识别模式", "info");
        }
    });

    // 卡片内视图切换按钮
    el("btnModePlot")?.addEventListener("click", () => switchStageMode("plot"));
    el("btnModeCube")?.addEventListener("click", () => switchStageMode("cube"));

    // 3D 姿态归零与复位
    el("btnCubeTare")?.addEventListener("click", () =>
    {
        if (cubeRenderer)
        {
            cubeRenderer.setTare();
            showToast("3D 姿态已归零 (Tare 校准)", "info");
        }
    });

    el("btnCubeReset")?.addEventListener("click", () =>
    {
        if (cubeRenderer)
        {
            cubeRenderer.resetCamera();
            cubeRenderer.resetTare();
            showToast("3D 视角与偏置已复位", "info");
        }
    });

    // 仿真演示按钮
    const btnMock = el("btnMockSim");
    if (btnMock)
    {
        btnMock.addEventListener("click", () =>
        {
            if (mockGen.isRunning)
            {
                mockGen.stop();
                btnMock.classList.remove("active");
                updateConnectionUi(false);
                addLog("全真信号仿真已停止", "info");
                showToast("仿真演示已停止", "info");
            }
            else
            {
                if (serial.isConnected)
                {
                    showToast("物理串口已连接，请先断开串口", "warning");
                    return;
                }
                mockGen.start();
                btnMock.classList.add("active");
                updateConnectionUi(true);
                el("connectionText").textContent = "1kHz 仿真演示中";
                el("connectionIndicator").className = "status-dot online";
                addLog("已开启 1kHz 4通道多波形与 3D 姿态全真仿真演示", "rx");
                showToast("1kHz 仿真演示运行中", "success");
            }
        });
    }

    // =========================================================================
    // 发送历史记录系统 (最大 10 条，localStorage 持久化，支持单条删除与清空)
    // =========================================================================
    const STORAGE_KEY_PLOTTER_HISTORY = "serial_plotter_send_history_v1";
    let plotterHistoryList = [];

    function loadPlotterHistory()
    {
        try
        {
            const saved = localStorage.getItem(STORAGE_KEY_PLOTTER_HISTORY);
            if (saved) { plotterHistoryList = JSON.parse(saved); }
        }
        catch (e) { plotterHistoryList = []; }
        renderPlotterHistory();
    }

    function savePlotterHistory()
    {
        try { localStorage.setItem(STORAGE_KEY_PLOTTER_HISTORY, JSON.stringify(plotterHistoryList)); }
        catch (e) {}
        renderPlotterHistory();
    }

    function addPlotterHistoryItem(text, mode)
    {
        if (!text) { return; }
        plotterHistoryList = plotterHistoryList.filter(item => item.text !== text);
        plotterHistoryList.unshift({ text, mode, time: Date.now() });
        if (plotterHistoryList.length > 10) { plotterHistoryList.pop(); }
        savePlotterHistory();
    }

    function deletePlotterHistoryItem(index, e)
    {
        if (e) { e.stopPropagation(); }
        plotterHistoryList.splice(index, 1);
        savePlotterHistory();
    }

    function renderPlotterHistory()
    {
        const container = el("historyList");
        if (!container) { return; }
        container.innerHTML = "";

        if (plotterHistoryList.length === 0)
        {
            const empty = document.createElement("div");
            empty.className = "history-empty-hint";
            empty.textContent = "暂无发送历史记录";
            container.appendChild(empty);
            return;
        }

        plotterHistoryList.forEach((item, idx) =>
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
            delBtn.addEventListener("click", ev => deletePlotterHistoryItem(idx, ev));

            row.appendChild(badge);
            row.appendChild(textSpan);
            row.appendChild(delBtn);

            row.addEventListener("click", () =>
            {
                if (el("inputSend"))
                {
                    el("inputSend").value = item.text;
                    el("inputSend").focus();
                }
                if (el("terminalTxMode"))
                {
                    el("terminalTxMode").value = item.mode === "hex" ? "hex" : "ascii";
                }
                el("historyPopup").style.display = "none";
            });

            container.appendChild(row);
        });
    }

    el("btnToggleSendHistory")?.addEventListener("click", e =>
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
            if (!popup.contains(e.target) && e.target !== el("btnToggleSendHistory"))
            {
                popup.style.display = "none";
            }
        }
    });

    el("btnClearAllHistory")?.addEventListener("click", () =>
    {
        plotterHistoryList = [];
        savePlotterHistory();
        showToast("已清空全部发送历史", "info");
    });

    // 终端清屏与发送
    el("btnClearLog")?.addEventListener("click", () =>
    {
        el("terminalOutput").innerHTML = "";
    });

    const sendAction = async () =>
    {
        const input = el("inputSend");
        const val = input.value.trim();
        if (!val) { return; }
        const txMode = el("terminalTxMode").value;
        const ending = el("terminalTxEnding").value;
        let suffix = "";
        if (ending === "crlf") { suffix = "\r\n"; }
        else if (ending === "lf") { suffix = "\n"; }

        try
        {
            if (txMode === "ascii")
            {
                await serial.sendText(val + suffix);
                addLog(`[TX] ${val}`, "tx");
            }
            else
            {
                const clean = val.replace(/0x/gi, "").replace(/[\s,;:_-]/g, "");
                if (!/^[0-9A-Fa-f]+$/.test(clean)) { throw new Error("HEX 只能包含0-9、A-F及常用分隔符"); }
                if (clean.length % 2 !== 0) { throw new Error("HEX 字节长度必须为偶数 (如 FF 01 02 FE)"); }
                const bytes = new Uint8Array(clean.length / 2);
                for (let i = 0; i < clean.length; i += 2)
                {
                    bytes[i / 2] = parseInt(clean.substring(i, i + 2), 16);
                }
                await serial.sendBytes(bytes);
                addLog(`[TX HEX] ${val}`, "tx");
            }
            addPlotterHistoryItem(val, txMode === "hex" ? "hex" : "txt");
            input.value = "";
        }
        catch (err)
        {
            showToast(err.message, "error");
        }
    };

    el("btnSend")?.addEventListener("click", sendAction);
    el("inputSend")?.addEventListener("keydown", e =>
    {
        if (e.key === "Enter")
        {
            sendAction();
        }
    });

    loadPlotterHistory();
}

// 统计帧率与采样率定时器 (1秒窗口)
window.setInterval(() =>
{
    const now = performance.now();
    const elapsed = Math.max(0.001, (now - frameWindowStart) / 1000);
    const measuredRate = Math.round(frameWindowCount / elapsed);
    lastMeasuredRate = measuredRate;
    if (measuredRate > 0)
    {
        const ratio = smoothedSampleRate > 0 ? measuredRate / smoothedSampleRate : 1;
        if (smoothedSampleRate === 0 || ratio < 0.75 || ratio > 1.25)
        {
            smoothedSampleRate = measuredRate;
        }
        else
        {
            smoothedSampleRate = smoothedSampleRate * 0.8 + measuredRate * 0.2;
        }
        plotter.setSampleRate(smoothedSampleRate);
    }
    const rateEl = el("statRate");
    if (rateEl) { rateEl.textContent = `${measuredRate} Hz`; }
    frameWindowCount = 0;
    frameWindowStart = now;
}, 1000);

document.addEventListener("DOMContentLoaded", () =>
{
    bindEvents();
    const savedProto = localStorage.getItem("plotter_protocol") || "justfloat";
    if (el("selectProtocol"))
    {
        el("selectProtocol").value = savedProto;
        serial.setProtocol(savedProto);
    }

    const savedFps = Number(localStorage.getItem("plotter_fps")) || 60;
    if (el("selectFps"))
    {
        el("selectFps").value = String(savedFps);
        plotter.setTargetFps(savedFps);
    }

    addLog("Universal Web Plotter 已就绪，支持 VOFA+ FireWater 与 JustFloat", "info");
});
