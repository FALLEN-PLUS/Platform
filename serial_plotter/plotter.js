"use strict";

/**
 * Universal Oscilloscope Canvas Engine · 现代化通用示波器内核
 * 特性:
 * 1. 30 FPS 节能渲染节流器 / 60 FPS 极速模式切换
 * 2. 物理时间双标尺 (停止线/起始线) 动态等比例缩放
 * 3. 鼠标指针绝对不动点缩放与拖拽平移
 * 4. 1～16 自适应动态通道与激光霓虹配色
 * 5. 双游标差值测量模式 (Delta Markers A/B)
 * 6. 全景 Minimap 时间小地图
 */
const PLOTTER_PALETTE = [
    "#0284C7", // 0: 晶体蓝
    "#059669", // 1: 翡翠绿
    "#DC2626", // 2: 鲜艳红
    "#7C3AED", // 3: 极光紫
    "#D97706", // 4: 琥珀金
    "#0D9488", // 5: 松石青
    "#E11D48", // 6: 玫瑰红
    "#4F46E5", // 7: 科技靛蓝
    "#16A34A", // 8: 翠绿
    "#C026D3", // 9: 亮洋红
    "#0891B2", // 10: 青蓝
    "#CA8A04", // 11: 暗金黄
    "#BE185D", // 12: 胭脂粉
    "#475569", // 13: 钛银灰
    "#059669", // 14: 森林绿
    "#9333EA"  // 15: 亮紫
];

class UniversalPlotter
{
    constructor(canvas, legendContainer, emptyHint, rangeLabel, tooltip, axisHint, overview)
    {
        this.canvas = canvas;
        this.context = canvas.getContext("2d");
        this.legendContainer = legendContainer;
        this.emptyHint = emptyHint;
        this.rangeLabel = rangeLabel;
        this.tooltip = tooltip;
        this.axisHint = axisHint;
        this.overview = overview;

        this.colors = PLOTTER_PALETTE;
        this.channelCount = 0;
        this.channelNames = [];
        this.channelUnits = [];
        this.channelVisible = [];
        this.latestValues = [];

        this.samples = [];
        this.sampleHead = 0;
        this.sampleIndex = 0;
        this.capacity = 20000;
        this.samplePeriodMs = 1;

        this.xDivisions = 10;
        this.defaultXPerDivMs = 200;
        this.xPerDivMs = 200;
        this.viewStartMs = -2000;
        this.viewEndMs = 0;
        this.xAuto = true;
        this.paused = false;
        this.frozenSamples = null;

        this.autoScale = true;
        this.lastRange = [-1, 1];

        this.targetFps = 30; // 默认 30 FPS 节能模式
        this.lastFrameTime = 0;
        this.lastLegendUpdateTime = 0;
        this.actualFps = 30;
        this.frameCountForFps = 0;
        this.fpsWindowStart = performance.now();

        // 交互与测量
        this.hoverPoint = null;
        this.hoverRegion = "outside";
        this.hoverChannel = null;
        this.dragState = null;
        this.overviewDrag = null;

        // 双游标测量状态
        this.markerMode = false;
        this.markerA = null; // { timeMs: number }
        this.markerB = null; // { timeMs: number }
        this.activeMarkerDrag = null; // "A" | "B"

        this.xViewNotificationPending = false;
        this.dirty = true;

        this.onAutoScaleChange = () => {};
        this.onPausedChange = () => {};
        this.onXViewChange = () => {};
        this.onChannelChange = () => {};
        this.onMarkerChange = () => {};

        this.resizeObserver = new ResizeObserver(() => this.resize());
        this.resizeObserver.observe(this.canvas.parentElement);
        this.bindPointerEvents();
        this.bindOverviewEvents();

        this.animationFrame = requestAnimationFrame(ts => this.drawLoop(ts));
    }

    clamp(value, minimum, maximum)
    {
        return Math.max(minimum, Math.min(maximum, value));
    }

    setTargetFps(fps)
    {
        this.targetFps = fps === 60 ? 60 : 30;
        this.dirty = true;
    }

    setSampleRate(rateHz)
    {
        if (!Number.isFinite(rateHz) || rateHz <= 0)
        {
            return;
        }

        const periodMs = 1000 / rateHz;
        if (Math.abs(periodMs - this.samplePeriodMs) / this.samplePeriodMs < 0.005)
        {
            return;
        }

        this.samplePeriodMs = periodMs;
        // Why: 串口帧没有自带时间戳，只能用实测帧率统一重标定，保证时间轴和CSV不固定假设1kHz。
        for (const sample of this.samples)
        {
            sample.timeMs = sample.index * this.samplePeriodMs;
        }
        this.notifyXViewChange();
        this.dirty = true;
    }

    resize()
    {
        const rect = this.canvas.getBoundingClientRect();
        const ratio = Math.max(1, window.devicePixelRatio || 1);
        const width = Math.max(1, Math.round(rect.width * ratio));
        const height = Math.max(1, Math.round(rect.height * ratio));
        if (this.canvas.width !== width || this.canvas.height !== height)
        {
            this.canvas.width = width;
            this.canvas.height = height;
            this.dirty = true;
        }
    }

    getGeometryCss()
    {
        const rect = this.canvas.getBoundingClientRect();
        const left = 68;
        const right = 16;
        const top = 16;
        const bottom = 40;
        return {
            rect, left, right, top, bottom,
            plotWidth: Math.max(1, rect.width - left - right),
            plotHeight: Math.max(1, rect.height - top - bottom)
        };
    }

    getPosition(event, geometry)
    {
        return { x: event.clientX - geometry.rect.left, y: event.clientY - geometry.rect.top };
    }

    getRegion(position, geometry)
    {
        const plotRight = geometry.rect.width - geometry.right;
        const plotBottom = geometry.rect.height - geometry.bottom;
        if (position.x <= geometry.left && position.y >= geometry.top && position.y <= plotBottom)
        {
            return "y-axis";
        }
        if (position.y >= plotBottom && position.x >= geometry.left && position.x <= plotRight)
        {
            return "x-axis";
        }
        if (position.x >= geometry.left && position.x <= plotRight &&
            position.y >= geometry.top && position.y <= plotBottom)
        {
            return "plot";
        }
        return "outside";
    }

    bindPointerEvents()
    {
        this.canvas.addEventListener("contextmenu", event => event.preventDefault());
        this.canvas.addEventListener("wheel", event => this.handleWheel(event), { passive: false });
        this.canvas.addEventListener("pointerdown", event => this.handlePointerDown(event));
        this.canvas.addEventListener("pointermove", event => this.handlePointerMove(event));
        this.canvas.addEventListener("pointerup", event => this.handlePointerUp(event));
        this.canvas.addEventListener("pointercancel", event => this.handlePointerUp(event));
        this.canvas.addEventListener("pointerleave", () =>
        {
            if (!this.dragState)
            {
                this.hoverPoint = null;
                this.hoverRegion = "outside";
                this.tooltip.style.display = "none";
                this.hideAxisHint();
                this.canvas.style.cursor = "crosshair";
                this.dirty = true;
            }
        });
        this.canvas.addEventListener("dblclick", event => this.handleDoubleClick(event));
        window.addEventListener("keydown", event =>
        {
            if (event.key === "Escape")
            {
                this.clearMarkers();
            }
        });
    }

    bindOverviewEvents()
    {
        if (!this.overview || !this.overview.container) { return; }

        const begin = (event, edge) =>
        {
            if (event.button !== 0) { return; }
            event.currentTarget.setPointerCapture(event.pointerId);
            this.overviewDrag = { pointerId: event.pointerId, edge };
            this.setPaused(true);
        };

        if (this.overview.start)
        {
            this.overview.start.addEventListener("pointerdown", event => begin(event, "start"));
        }
        if (this.overview.end)
        {
            this.overview.end.addEventListener("pointerdown", event => begin(event, "end"));
        }

        this.overview.container.addEventListener("pointermove", event =>
        {
            if (!this.overviewDrag || this.overviewDrag.pointerId !== event.pointerId) { return; }
            const bounds = this.getOverviewBounds();
            const rect = this.overview.container.getBoundingClientRect();
            const ratio = this.clamp((event.clientX - rect.left) / Math.max(1, rect.width), 0, 1);
            const timeMs = bounds.minimum + ratio * (bounds.maximum - bounds.minimum);
            if (this.overviewDrag.edge === "start")
            {
                this.setViewBounds(timeMs, this.viewEndMs);
            }
            else
            {
                this.setViewBounds(this.viewStartMs, timeMs);
            }
        });

        const finish = event =>
        {
            if (this.overviewDrag && this.overviewDrag.pointerId === event.pointerId)
            {
                this.overviewDrag = null;
            }
        };
        this.overview.container.addEventListener("pointerup", finish);
        this.overview.container.addEventListener("pointercancel", finish);
    }

    handleWheel(event)
    {
        event.preventDefault();
        const geometry = this.getGeometryCss();
        const position = this.getPosition(event, geometry);
        const region = this.getRegion(position, geometry);

        if (region === "y-axis" || (region === "plot" && event.ctrlKey))
        {
            this.zoomY(event.deltaY, position.y, geometry);
        }
        else if (region === "x-axis" || region === "plot")
        {
            this.zoomX(event.deltaY, position.x, geometry);
        }
    }

    zoomX(deltaY, pointerX, geometry)
    {
        const cursorRatio = this.clamp((pointerX - geometry.left) / geometry.plotWidth, 0, 1);
        const anchorMs = this.viewStartMs + cursorRatio * (this.viewEndMs - this.viewStartMs);
        const factor = deltaY < 0 ? 0.82 : 1.22;
        const currentSpan = Math.max(1e-6, this.viewEndMs - this.viewStartMs);
        const newSpan = this.clamp(currentSpan * factor, 0.001, 1e12);
        this.xPerDivMs = newSpan / this.xDivisions;

        // 以鼠标不动点为锚点进行缩放
        this.viewStartMs = anchorMs - cursorRatio * newSpan;
        this.viewEndMs = this.viewStartMs + newSpan;

        // 滚轮缩放自动解除 Auto 跟随，锁定观察视口
        this.xAuto = false;
        this.notifyXViewChange();
        this.dirty = true;
    }

    zoomY(deltaY, pointerY, geometry)
    {
        if (this.autoScale)
        {
            this.computeRange(this.getVisibleSamples());
        }
        const oldSpan = Math.max(1e-9, this.lastRange[1] - this.lastRange[0]);
        const newSpan = this.clamp(oldSpan * (deltaY > 0 ? 1.18 : 1 / 1.18), 1e-9, 1e12);
        const yRatio = this.clamp((pointerY - geometry.top) / geometry.plotHeight, 0, 1);
        const cursorValue = this.lastRange[1] - oldSpan * yRatio;
        const newMaximum = cursorValue + newSpan * yRatio;
        this.lastRange = [newMaximum - newSpan, newMaximum];
        this.setAutoScale(false);
        this.dirty = true;
    }

    handlePointerDown(event)
    {
        const geometry = this.getGeometryCss();
        const position = this.getPosition(event, geometry);
        const region = this.getRegion(position, geometry);

        if (region === "outside") { return; }

        this.canvas.setPointerCapture(event.pointerId);
        if (this.autoScale && (region === "y-axis" || region === "plot" || event.button === 1 || event.button === 2))
        {
            this.computeRange(this.getVisibleSamples());
        }

        let mode = "pan-xy";
        if (event.button === 2 || (event.button === 0 && event.shiftKey))
        {
            mode = "rubberband";
        }
        else if (region === "y-axis")
        {
            mode = "pan-y";
        }
        else if (region === "x-axis")
        {
            mode = "pan-x";
        }
        else if (region === "plot" || event.button === 1)
        {
            mode = "pan-xy";
        }

        this.dragState = {
            pointerId: event.pointerId,
            mode,
            region,
            button: event.button,
            startX: event.clientX,
            startY: event.clientY,
            startPos: position,
            boxCurrent: { x: event.clientX, y: event.clientY },
            startView: [this.viewStartMs, this.viewEndMs],
            startRange: this.lastRange.slice()
        };

        if (mode === "pan-x" || mode === "pan-xy" || mode === "rubberband")
        {
            this.xAuto = false;
            this.notifyXViewChange();
        }
        if (mode === "pan-y" || mode === "pan-xy")
        {
            this.setAutoScale(false);
        }

        this.canvas.parentElement.classList.add("dragging");
        this.updatePointerPresentation(position, geometry);
        this.dirty = true;
    }

    handlePointerMove(event)
    {
        const geometry = this.getGeometryCss();
        const position = this.getPosition(event, geometry);
        this.hoverPoint = position;
        this.hoverRegion = this.getRegion(position, geometry);

        if (this.dragState && this.dragState.pointerId === event.pointerId)
        {
            const mode = this.dragState.mode;
            if (mode === "rubberband")
            {
                this.dragState.boxCurrent = { x: event.clientX, y: event.clientY };
            }
            else
            {
                if (mode === "pan-x" || mode === "pan-xy")
                {
                    const span = this.dragState.startView[1] - this.dragState.startView[0];
                    const deltaMs = -((event.clientX - this.dragState.startX) / geometry.plotWidth) * span;
                    this.viewStartMs = this.dragState.startView[0] + deltaMs;
                    this.viewEndMs = this.dragState.startView[1] + deltaMs;
                    this.notifyXViewChange();
                }
                if (mode === "pan-y" || mode === "pan-xy")
                {
                    const span = this.dragState.startRange[1] - this.dragState.startRange[0];
                    const deltaValue = ((event.clientY - this.dragState.startY) / geometry.plotHeight) * span;
                    this.lastRange = [this.dragState.startRange[0] + deltaValue, this.dragState.startRange[1] + deltaValue];
                }
            }
        }
        else
        {
            this.updatePointerPresentation(position, geometry);
        }
        this.dirty = true;
    }

    updatePointerPresentation(position, geometry)
    {
        if (this.dragState)
        {
            this.canvas.style.cursor = this.dragState.mode === "rubberband" ? "crosshair" : "grabbing";
            this.hideAxisHint();
            return;
        }

        if (this.hoverRegion === "x-axis")
        {
            this.canvas.style.cursor = "ew-resize";
            this.showAxisHint("X 轴时基 · 滚轮缩放 / 拖拽平移 / 双击复位", position, geometry);
        }
        else if (this.hoverRegion === "y-axis")
        {
            this.canvas.style.cursor = "ns-resize";
            this.showAxisHint("Y 轴量程 · 滚轮缩放 / 拖拽平移 / 双击自动", position, geometry);
        }
        else if (this.hoverRegion === "plot")
        {
            this.canvas.style.cursor = "crosshair";
            this.hideAxisHint();
        }
        else
        {
            this.canvas.style.cursor = "default";
            this.hideAxisHint();
        }
    }

    showAxisHint(text, position, geometry)
    {
        if (!this.axisHint) { return; }
        this.axisHint.textContent = text;
        this.axisHint.style.display = "block";
        const left = position.x < geometry.rect.width * 0.55 ? position.x + 14 : position.x - 200;
        this.axisHint.style.left = `${Math.max(6, left)}px`;
        this.axisHint.style.top = `${this.clamp(position.y - 28, 6, geometry.rect.height - 50)}px`;
    }

    hideAxisHint()
    {
        if (this.axisHint)
        {
            this.axisHint.style.display = "none";
        }
    }

    handlePointerUp(event)
    {
        if (!this.dragState || this.dragState.pointerId !== event.pointerId) { return; }

        const geometry = this.getGeometryCss();
        if (this.dragState.mode === "rubberband" && this.dragState.boxCurrent)
        {
            const p1 = this.getPosition({ clientX: this.dragState.startX, clientY: this.dragState.startY }, geometry);
            const p2 = this.getPosition(event, geometry);
            const boxWidth = Math.abs(p2.x - p1.x);
            const boxHeight = Math.abs(p2.y - p1.y);

            if (boxWidth >= 10 && boxHeight >= 10)
            {
                const xMin = Math.min(p1.x, p2.x);
                const xMax = Math.max(p1.x, p2.x);
                const yMin = Math.min(p1.y, p2.y);
                const yMax = Math.max(p1.y, p2.y);

                const viewSpan = this.viewEndMs - this.viewStartMs;
                const newStartMs = this.viewStartMs + ((xMin - geometry.left) / geometry.plotWidth) * viewSpan;
                const newEndMs = this.viewStartMs + ((xMax - geometry.left) / geometry.plotWidth) * viewSpan;

                const [currentMinY, currentMaxY] = this.lastRange;
                const ySpan = currentMaxY - currentMinY;
                const newMaxY = currentMaxY - ((yMin - geometry.top) / geometry.plotHeight) * ySpan;
                const newMinY = currentMaxY - ((yMax - geometry.top) / geometry.plotHeight) * ySpan;

                if (newEndMs > newStartMs && newMaxY > newMinY)
                {
                    this.viewStartMs = newStartMs;
                    this.viewEndMs = newEndMs;
                    this.xPerDivMs = (newEndMs - newStartMs) / this.xDivisions;
                    this.lastRange = [newMinY, newMaxY];
                    this.setAutoScale(false);
                    this.setXAuto(false);
                    this.notifyXViewChange();
                }
            }
        }

        if (this.canvas.hasPointerCapture(event.pointerId))
        {
            this.canvas.releasePointerCapture(event.pointerId);
        }
        this.dragState = null;
        this.canvas.parentElement.classList.remove("dragging");
        this.updatePointerPresentation(this.hoverPoint || { x: 0, y: 0 }, geometry);
        this.dirty = true;
    }

    handleDoubleClick(event)
    {
        const geometry = this.getGeometryCss();
        const pos = this.getPosition(event, geometry);
        const region = this.getRegion(pos, geometry);

        if (region === "plot")
        {
            // 若当前处于运行状态，双击波形自动定格暂停以进行精准测量
            if (!this.paused)
            {
                this.setPaused(true);
            }

            // 双击固定 VOFA+ 差值测量点 (Marker A / Marker B)
            const samples = this.getVisibleSamples();
            if (samples.length > 0)
            {
                const xCss = this.clamp(pos.x, geometry.left, geometry.rect.width - geometry.right);
                const yCss = this.clamp(pos.y, geometry.top, geometry.rect.height - geometry.bottom);
                const targetRelTime = this.viewStartMs + ((xCss - geometry.left) / geometry.plotWidth) * (this.viewEndMs - this.viewStartMs);
                const buffer = this.getBufferTimeRange();
                const latestMs = buffer.hasData ? buffer.latestMs : 0;

                let closestSample = samples[0];
                for (const candidate of samples)
                {
                    const rel = candidate.timeMs - latestMs;
                    if (Math.abs(rel - targetRelTime) < Math.abs((closestSample.timeMs - latestMs) - targetRelTime))
                    {
                        closestSample = candidate;
                    }
                }

                // 找到 Y 距离鼠标最近的有效通道
                const [minimum, maximum] = this.computeRange(samples);
                const cursorVal = maximum - (maximum - minimum) * ((yCss - geometry.top) / geometry.plotHeight);
                let closestCh = 0;
                let minValDiff = Infinity;
                for (let ch = 0; ch < this.channelCount; ch++)
                {
                    if (this.channelVisible[ch] && ch < closestSample.values.length)
                    {
                        const diff = Math.abs(closestSample.values[ch] - cursorVal);
                        if (diff < minValDiff)
                        {
                            minValDiff = diff;
                            closestCh = ch;
                        }
                    }
                }

                const pointVal = closestSample.values[closestCh];
                const markerData = {
                    timeMs: closestSample.timeMs,
                    val: pointVal,
                    ch: closestCh,
                    chName: this.channelNames[closestCh] || `CH${closestCh + 1}`,
                    color: this.colors[closestCh % this.colors.length]
                };

                if (!this.markerA)
                {
                    this.markerA = { ...markerData, label: "A" };
                }
                else if (!this.markerB)
                {
                    this.markerB = { ...markerData, label: "B" };
                }
                else
                {
                    // 两点均已固定时，再次双击重置为点 A 并清空点 B
                    this.markerA = { ...markerData, label: "A" };
                    this.markerB = null;
                }
                this.dirty = true;
                this.onMarkerChange({ markerA: this.markerA, markerB: this.markerB });
                return;
            }
        }

        if (region === "x-axis")
        {
            this.resetXView();
        }
        if (region === "y-axis")
        {
            this.setAutoScale(true);
        }
    }

    clearMarkers()
    {
        this.markerA = null;
        this.markerB = null;
        this.dirty = true;
        this.onMarkerChange({ markerA: null, markerB: null });
    }

    setXAuto(enabled)
    {
        this.xAuto = enabled;
        if (enabled)
        {
            this.setPaused(false);
            if (this.defaultXPerDivMs)
            {
                this.xPerDivMs = this.defaultXPerDivMs;
            }
            const span = this.xPerDivMs * this.xDivisions;
            this.viewStartMs = -span;
            this.viewEndMs = 0;
        }
        else
        {
            this.setPaused(true);
        }
        this.notifyXViewChange();
        this.dirty = true;
    }

    resetXView()
    {
        this.setXAuto(true);
    }

    getBufferTimeRange()
    {
        const source = this.frozenSamples || this.samples;
        const startIndex = this.frozenSamples ? 0 : this.sampleHead;
        if (!source || source.length <= startIndex)
        {
            return { hasData: false, firstMs: 0, latestMs: 0, count: 0 };
        }
        const firstMs = source[startIndex].timeMs;
        const latestMs = source[source.length - 1].timeMs;
        return { hasData: true, firstMs, latestMs, count: source.length - startIndex };
    }

    followLatest(force = false)
    {
        const span = this.xPerDivMs * this.xDivisions;
        let changed = false;
        if (force || this.xAuto)
        {
            const targetStart = -span;
            const targetEnd = 0;
            changed = Math.abs(this.viewStartMs - targetStart) > 1e-6 || Math.abs(this.viewEndMs - targetEnd) > 1e-6;
            this.viewStartMs = targetStart;
            this.viewEndMs = targetEnd;
        }
        return changed;
    }

    addSample(values)
    {
        const safeValues = values.map(v => (Number.isFinite(v) && Math.abs(v) <= 1e9 ? v : 0));
        const count = safeValues.length;
        if (count !== this.channelCount)
        {
            this.ensureChannelCapacity(count);
        }

        if (!this.paused)
        {
            this.latestValues = safeValues.slice();
        }

        const timeMs = this.sampleIndex * this.samplePeriodMs;
        this.samples.push({ index: this.sampleIndex, timeMs, values: safeValues.slice() });
        this.sampleIndex++;

        if (this.samples.length - this.sampleHead > this.capacity)
        {
            this.sampleHead++;
            if (this.sampleHead >= 1000)
            {
                this.samples.splice(0, this.sampleHead);
                this.sampleHead = 0;
            }
        }

        if (this.xAuto && !this.paused)
        {
            if (this.followLatest(false))
            {
                this.xViewNotificationPending = true;
            }
        }

        if (!this.paused)
        {
            if (this.emptyHint) { this.emptyHint.style.display = "none"; }
            this.dirty = true;
        }
    }

    ensureChannelCapacity(count)
    {
        if (count <= 0) { return; }
        if (count === this.channelCount) { return; }

        this.channelCount = count;
        if (this.channelNames.length > count)
        {
            // Why: 更换设备或协议后必须移除旧通道，避免残留图例被误认为仍有数据。
            this.channelNames.length = count;
            this.channelUnits.length = count;
            this.channelVisible.length = count;
        }
        else
        {
            while (this.channelNames.length < count)
            {
                const idx = this.channelNames.length;
                this.channelNames.push(`CH${idx + 1}`);
                this.channelUnits.push("");
                this.channelVisible.push(true);
            }
        }
        this.latestValues = this.latestValues.slice(0, count);
        this.buildLegend();
        this.onChannelChange(this.channelCount);
    }

    setPaused(paused)
    {
        const changed = this.paused !== paused;
        if (!changed) { return; }

        if (paused)
        {
            this.frozenSamples = this.samples.slice(this.sampleHead);
        }
        else
        {
            this.frozenSamples = null;
            if (this.samples.length > this.sampleHead)
            {
                this.latestValues = this.samples[this.samples.length - 1].values.slice();
            }
        }
        this.paused = paused;
        this.xAuto = !paused;
        if (!paused)
        {
            this.clearMarkers();
            this.followLatest(true);
        }
        this.onPausedChange(paused);
        this.notifyXViewChange();
        this.dirty = true;
    }

    clear()
    {
        this.clearMarkers();
        this.samples = [];
        this.sampleHead = 0;
        this.sampleIndex = 0;
        this.frozenSamples = this.paused ? [] : null;
        this.latestValues = Array(this.channelCount).fill(NaN);
        const span = this.xPerDivMs * this.xDivisions;
        this.viewStartMs = -span;
        this.viewEndMs = 0;
        this.hoverPoint = null;
        if (this.tooltip) { this.tooltip.style.display = "none"; }
        this.hideAxisHint();
        if (this.emptyHint) { this.emptyHint.style.display = "grid"; }
        this.notifyXViewChange();
        this.dirty = true;
    }

    setAutoScale(enabled)
    {
        const changed = this.autoScale !== enabled;
        this.autoScale = enabled;
        if (changed)
        {
            this.onAutoScaleChange(enabled);
        }
        this.dirty = true;
    }

    getVisibleSamples()
    {
        const source = this.frozenSamples || this.samples;
        const startIndex = this.frozenSamples ? 0 : this.sampleHead;
        if (!source || source.length <= startIndex) { return []; }

        const latestMs = source[source.length - 1].timeMs;
        const targetStartTime = latestMs + this.viewStartMs;
        const targetEndTime = latestMs + this.viewEndMs;

        let low = startIndex;
        let high = source.length - 1;
        let firstIdx = source.length;
        while (low <= high)
        {
            const mid = (low + high) >> 1;
            if (source[mid].timeMs >= targetStartTime)
            {
                firstIdx = mid;
                high = mid - 1;
            }
            else
            {
                low = mid + 1;
            }
        }

        low = startIndex;
        high = source.length - 1;
        let lastIdx = startIndex - 1;
        while (low <= high)
        {
            const mid = (low + high) >> 1;
            if (source[mid].timeMs <= targetEndTime)
            {
                lastIdx = mid;
                low = mid + 1;
            }
            else
            {
                high = mid - 1;
            }
        }

        if (firstIdx > lastIdx && firstIdx < source.length && lastIdx >= startIndex)
        {
            return [source[lastIdx], source[firstIdx]];
        }

        const start = Math.max(startIndex, firstIdx - 1);
        const end = Math.min(source.length - 1, lastIdx + 1);
        if (start > end) { return []; }
        return source.slice(start, end + 1);
    }

    computeRange(samples)
    {
        if (!this.autoScale) { return this.lastRange; }
        let minimum = Infinity;
        let maximum = -Infinity;
        let validCount = 0;

        for (const sample of samples)
        {
            for (let channel = 0; channel < this.channelCount; channel++)
            {
                // 核心法则：严格仅根据用户当前【勾选/可见】的通道计算 Y 轴量程
                if (this.channelVisible[channel] && channel < sample.values.length)
                {
                    const val = sample.values[channel];
                    // 过滤极端野值与非法数值
                    if (Number.isFinite(val) && Math.abs(val) <= 1e9)
                    {
                        minimum = Math.min(minimum, val);
                        maximum = Math.max(maximum, val);
                        validCount++;
                    }
                }
            }
        }

        if (validCount === 0 || !Number.isFinite(minimum) || !Number.isFinite(maximum))
        {
            return this.lastRange;
        }

        if (minimum === maximum)
        {
            const margin = Math.max(1.0, Math.abs(minimum) * 0.1);
            minimum -= margin;
            maximum += margin;
        }
        else
        {
            const margin = (maximum - minimum) * 0.08;
            minimum -= margin;
            maximum += margin;
        }

        this.lastRange = [minimum, maximum];
        return this.lastRange;
    }

    notifyXViewChange()
    {
        this.updateOverview();
        this.onXViewChange({
            startMs: this.viewStartMs,
            endMs: this.viewEndMs,
            xPerDivMs: this.xPerDivMs,
            periodMs: this.samplePeriodMs,
            xAuto: this.xAuto,
            capacity: this.capacity
        });
    }

    getOverviewBounds()
    {
        const capacityMs = this.samplePeriodMs * this.capacity;
        return {
            minimum: Math.min(-capacityMs, this.viewStartMs),
            maximum: Math.max(0, this.viewEndMs)
        };
    }

    updateOverview()
    {
        if (!this.overview || !this.overview.container) { return; }
        const bounds = this.getOverviewBounds();
        const span = Math.max(1e-9, bounds.maximum - bounds.minimum);
        const position = value => this.clamp(((value - bounds.minimum) / span) * 100, 0, 100);
        const start = position(this.viewStartMs);
        const end = position(this.viewEndMs);
        const latest = position(0);

        if (this.overview.window)
        {
            this.overview.window.style.left = `${start}%`;
            this.overview.window.style.width = `${Math.max(0.4, end - start)}%`;
        }
        if (this.overview.start)
        {
            this.overview.start.style.left = `${start}%`;
        }
        if (this.overview.end)
        {
            this.overview.end.style.left = `${end}%`;
        }
        if (this.overview.latest)
        {
            this.overview.latest.style.left = `${latest}%`;
        }
    }

    buildLegend()
    {
        if (!this.legendContainer) { return; }
        this.legendContainer.innerHTML = "";

        for (let i = 0; i < this.channelCount; i++)
        {
            const channelColor = this.colors[i % this.colors.length];
            const item = document.createElement("label");
            item.className = "channel-item";
            item.title = "点击切换显示 · 双击独占此通道";

            const checkbox = document.createElement("input");
            checkbox.type = "checkbox";
            checkbox.checked = this.channelVisible[i] !== false;
            checkbox.addEventListener("change", () =>
            {
                this.channelVisible[i] = checkbox.checked;
                this.dirty = true;
            });

            const colorBadge = document.createElement("span");
            colorBadge.className = "channel-color-dot";
            colorBadge.style.backgroundColor = channelColor;

            const nameInput = document.createElement("input");
            nameInput.type = "text";
            nameInput.className = "channel-name-input";
            nameInput.value = this.channelNames[i] || `CH${i + 1}`;
            nameInput.addEventListener("change", () =>
            {
                this.channelNames[i] = nameInput.value;
                this.dirty = true;
            });

            const val = document.createElement("strong");
            val.className = "channel-value";
            val.dataset.channelIndex = String(i);
            val.textContent = "--";

            item.addEventListener("mouseenter", () => { this.hoverChannel = i; this.dirty = true; });
            item.addEventListener("mouseleave", () => { this.hoverChannel = null; this.dirty = true; });
            item.addEventListener("dblclick", event =>
            {
                event.preventDefault();
                const onlyThis = this.channelVisible.filter(Boolean).length === 1 && this.channelVisible[i];
                this.channelVisible = this.channelVisible.map((unused, c) => onlyThis || c === i);
                this.buildLegend();
                this.dirty = true;
            });

            item.append(checkbox, colorBadge, nameInput, val);
            this.legendContainer.appendChild(item);
        }
        this.updateLegendValues();
    }

    updateLegendValues()
    {
        if (!this.legendContainer) { return; }
        this.legendContainer.querySelectorAll("[data-channel-index]").forEach(item =>
        {
            const idx = Number(item.dataset.channelIndex);
            if (idx < this.latestValues.length)
            {
                const val = this.latestValues[idx];
                item.textContent = Number.isFinite(val) ? val.toFixed(4) : "--";
            }
        });
    }

    formatTime(valueMs)
    {
        const sign = valueMs < 0 ? "-" : "";
        const absolute = Math.abs(valueMs);
        if (absolute < 1000) { return `${sign}${Number(absolute.toFixed(3))} ms`; }
        if (absolute < 60000) { return `${sign}${Number((absolute / 1000).toFixed(3))} s`; }
        return `${sign}${(absolute / 60000).toFixed(2)} min`;
    }

    formatAxisValue(value)
    {
        const absolute = Math.abs(value);
        return absolute >= 10000 || (absolute > 0 && absolute < 0.001) ? value.toExponential(3) : value.toFixed(3);
    }

    drawLoop(timestamp)
    {
        if (!this.lastFrameTime)
        {
            this.lastFrameTime = timestamp;
        }

        const interval = 1000 / this.targetFps;
        const elapsed = timestamp - this.lastFrameTime;

        // 30 FPS / 60 FPS 节能渲染节流
        if (elapsed >= interval - 1.5)
        {
            if (this.dirty)
            {
                this.draw();
                this.dirty = false;
            }
            this.lastFrameTime = timestamp;
            this.frameCountForFps++;
        }

        // FPS 实时统计
        const now = performance.now();
        if (now - this.fpsWindowStart >= 1000)
        {
            this.actualFps = Math.round((this.frameCountForFps * 1000) / (now - this.fpsWindowStart));
            this.frameCountForFps = 0;
            this.fpsWindowStart = now;
        }

        this.animationFrame = requestAnimationFrame(ts => this.drawLoop(ts));
    }

    draw()
    {
        const now = performance.now();
        if (now - this.lastLegendUpdateTime > 100)
        {
            this.lastLegendUpdateTime = now;
            this.updateLegendValues();
        }

        if (this.xViewNotificationPending)
        {
            this.xViewNotificationPending = false;
            this.notifyXViewChange();
        }
        else
        {
            this.updateOverview();
        }

        const context = this.context;
        const width = this.canvas.width;
        const height = this.canvas.height;
        const ratio = Math.max(1, window.devicePixelRatio || 1);
        const left = 68 * ratio;
        const right = 16 * ratio;
        const top = 16 * ratio;
        const bottom = 40 * ratio;
        const plotWidth = Math.max(1, width - left - right);
        const plotHeight = Math.max(1, height - top - bottom);

        // 全画幅高精工控浅色示波器背景
        context.fillStyle = "#FFFFFF";
        context.fillRect(0, 0, width, height);

        // 示波器主网格视口区域 (纯白微晶工作区)
        const bgGrad = context.createLinearGradient(0, top, 0, height - bottom);
        bgGrad.addColorStop(0, "#FFFFFF");
        bgGrad.addColorStop(1, "#F8FAFC");
        context.fillStyle = bgGrad;
        context.fillRect(left, top, plotWidth, plotHeight);

        // 视口精细边框
        context.strokeStyle = "rgba(203, 213, 225, 0.85)";
        context.lineWidth = 1 * ratio;
        context.strokeRect(left, top, plotWidth, plotHeight);

        const samples = this.getVisibleSamples();
        const [minimum, maximum] = this.computeRange(samples);
        if (this.rangeLabel)
        {
            this.rangeLabel.textContent = `Y: ${this.formatAxisValue(minimum)} ～ ${this.formatAxisValue(maximum)}`;
        }

        // 精密网格线 (优雅工控微网格)
        context.lineWidth = 1 * ratio;
        context.strokeStyle = "rgba(15, 23, 42, 0.06)";
        context.fillStyle = "#64748B"; // Slate 500 高清晰度字阶
        context.font = `600 ${10 * ratio}px "JetBrains Mono", Consolas, monospace`;
        context.textAlign = "right";
        context.textBaseline = "middle";

        for (let row = 0; row <= 5; row++)
        {
            const y = top + (plotHeight * row) / 5;
            context.beginPath(); context.moveTo(left, y); context.lineTo(width - right, y); context.stroke();
            context.fillText(this.formatAxisValue(maximum - ((maximum - minimum) * row) / 5), left - 8 * ratio, y);
        }

        context.textAlign = "center";
        context.textBaseline = "top";
        for (let col = 0; col <= this.xDivisions; col++)
        {
            const x = left + (plotWidth * col) / this.xDivisions;
            context.beginPath(); context.moveTo(x, top); context.lineTo(x, height - bottom); context.stroke();
            context.fillText(this.formatTime(this.viewStartMs + this.xPerDivMs * col), x, height - bottom + 8 * ratio);
        }

        // 右上角 HUD 状态
        context.save();
        context.font = `700 ${10 * ratio}px -apple-system, BlinkMacSystemFont, "JetBrains Mono", monospace`;
        context.textAlign = "right";
        context.textBaseline = "top";
        if (this.paused)
        {
            context.fillStyle = "#F59E0B";
            context.fillText("❚❚ PAUSED", width - right - 10 * ratio, top + 8 * ratio);
        }
        else
        {
            context.fillStyle = "#34D399";
            context.fillText(`● ${this.actualFps} FPS LIVE (${this.targetFps} MAX)`, width - right - 10 * ratio, top + 8 * ratio);
        }
        context.restore();

        // 曲线硬裁剪绘制
        context.save();
        context.beginPath();
        context.rect(left, top, plotWidth, plotHeight);
        context.clip();

        const viewSpan = Math.max(1e-12, this.viewEndMs - this.viewStartMs);
        const ySpan = Math.max(1e-12, maximum - minimum);
        const buffer = this.getBufferTimeRange();
        const latestMs = buffer.hasData ? buffer.latestMs : 0;
        const capacityMs = this.samplePeriodMs * this.capacity;
        const sampleCount = samples.length;
        const useDecimation = sampleCount > plotWidth * 1.5;

        for (let ch = 0; ch < this.channelCount; ch++)
        {
            if (!this.channelVisible[ch] || sampleCount === 0) { continue; }

            const color = this.colors[ch % this.colors.length];
            const isHovered = this.hoverChannel === ch;
            const hasFocus = this.hoverChannel !== null;

            context.save();
            context.beginPath();
            context.strokeStyle = color;
            context.shadowColor = color;
            context.shadowBlur = (isHovered ? 8 : 3.5) * ratio;

            if (hasFocus)
            {
                context.globalAlpha = isHovered ? 1.0 : 0.2;
                context.lineWidth = (isHovered ? 2.6 : 1.2) * ratio;
            }
            else
            {
                context.globalAlpha = 1.0;
                context.lineWidth = 1.6 * ratio;
            }

            if (!useDecimation)
            {
                // 点数适中：直接连线绘制
                let hasMoved = false;
                for (let idx = 0; idx < sampleCount; idx++)
                {
                    const sample = samples[idx];
                    if (ch < sample.values.length)
                    {
                        const val = sample.values[ch];
                        const relTime = sample.timeMs - latestMs;
                        const x = left + ((relTime - this.viewStartMs) / viewSpan) * plotWidth;
                        const y = top + plotHeight * (1 - (val - minimum) / ySpan);
                        if (!hasMoved) { context.moveTo(x, y); hasMoved = true; }
                        else { context.lineTo(x, y); }
                    }
                }
            }
            else
            {
                // 高频大点数 (10,000+ 点)：uPlot 工业级像素列 MinMax 降采样 (100% 极值保真 + 极速 60 FPS)
                let currentPixel = -1;
                let minVal = Infinity, maxVal = -Infinity;
                let minIdx = -1, maxIdx = -1;
                let firstVal = 0, lastVal = 0;
                let hasMoved = false;

                const flushColumn = () =>
                {
                    if (currentPixel < 0 || minIdx < 0) { return; }
                    const x = left + currentPixel;
                    const yFirst = top + plotHeight * (1 - (firstVal - minimum) / ySpan);
                    const yMin = top + plotHeight * (1 - (minVal - minimum) / ySpan);
                    const yMax = top + plotHeight * (1 - (maxVal - minimum) / ySpan);
                    const yLast = top + plotHeight * (1 - (lastVal - minimum) / ySpan);

                    if (!hasMoved)
                    {
                        context.moveTo(x, yFirst);
                        hasMoved = true;
                    }
                    else
                    {
                        context.lineTo(x, yFirst);
                    }

                    if (minIdx <= maxIdx)
                    {
                        context.lineTo(x, yMin);
                        context.lineTo(x, yMax);
                    }
                    else
                    {
                        context.lineTo(x, yMax);
                        context.lineTo(x, yMin);
                    }

                    if (yLast !== yMax && yLast !== yMin)
                    {
                        context.lineTo(x, yLast);
                    }
                };

                for (let idx = 0; idx < sampleCount; idx++)
                {
                    const sample = samples[idx];
                    if (ch >= sample.values.length) { continue; }
                    const val = sample.values[ch];
                    const relTime = sample.timeMs - latestMs;
                    const pixelX = Math.round(((relTime - this.viewStartMs) / viewSpan) * plotWidth);

                    if (pixelX !== currentPixel)
                    {
                        flushColumn();
                        currentPixel = pixelX;
                        minVal = val;
                        maxVal = val;
                        minIdx = idx;
                        maxIdx = idx;
                        firstVal = val;
                        lastVal = val;
                    }
                    else
                    {
                        if (val < minVal) { minVal = val; minIdx = idx; }
                        if (val > maxVal) { maxVal = val; maxIdx = idx; }
                        lastVal = val;
                    }
                }
                flushColumn();
            }

            context.stroke();
            context.restore();
        }

        // 框选局部放大高亮
        if (this.dragState && this.dragState.mode === "rubberband" && this.dragState.boxCurrent)
        {
            const geometry = { rect: this.canvas.getBoundingClientRect() };
            const p1 = this.getPosition({ clientX: this.dragState.startX, clientY: this.dragState.startY }, geometry);
            const p2 = this.getPosition({ clientX: this.dragState.boxCurrent.x, clientY: this.dragState.boxCurrent.y }, geometry);
            const bx = Math.min(p1.x, p2.x) * ratio;
            const by = Math.min(p1.y, p2.y) * ratio;
            const bw = Math.abs(p1.x - p2.x) * ratio;
            const bh = Math.abs(p1.y - p2.y) * ratio;

            context.fillStyle = "rgba(13, 148, 136, 0.2)";
            context.fillRect(bx, by, bw, bh);
            context.strokeStyle = "#14B8A6";
            context.lineWidth = 1.5 * ratio;
            context.setLineDash([4 * ratio, 3 * ratio]);
            context.strokeRect(bx, by, bw, bh);
        }

        context.restore();

        // 物理时间首尾双标尺 (红线停止线 -capacityMs / 紫线起始线 0 ms)
        const firstRel = -capacityMs;
        const latestRel = 0;

        const firstX = left + ((firstRel - this.viewStartMs) / viewSpan) * plotWidth;
        const latestX = left + ((latestRel - this.viewStartMs) / viewSpan) * plotWidth;

        // 1. 左边停止线 (Stop Line)
        if (firstX >= left - 60 * ratio && firstX <= left + plotWidth + 60 * ratio)
        {
            if (firstX >= left && firstX <= left + plotWidth)
            {
                context.save();
                context.beginPath();
                context.strokeStyle = "rgba(239, 68, 68, 0.9)";
                context.lineWidth = 1.4 * ratio;
                context.setLineDash([4 * ratio, 3 * ratio]);
                context.moveTo(firstX, top);
                context.lineTo(firstX, height - bottom);
                context.stroke();
                context.restore();
            }

            // 红色胶囊
            context.save();
            const startLabel = this.formatTime(firstRel);
            context.font = `bold ${9.5 * ratio}px "JetBrains Mono", monospace`;
            const startLabelWidth = context.measureText(startLabel).width + 10 * ratio;
            const labelHeight = 16 * ratio;
            const startLabelX = this.clamp(firstX - startLabelWidth / 2, left, left + plotWidth - startLabelWidth);
            const labelY = height - bottom + 3 * ratio;

            context.fillStyle = "#EF4444";
            this.roundRect(context, startLabelX, labelY, startLabelWidth, labelHeight, 3 * ratio);
            context.fill();

            context.fillStyle = "#FFFFFF";
            context.textAlign = "center";
            context.textBaseline = "middle";
            context.fillText(startLabel, startLabelX + startLabelWidth / 2, labelY + labelHeight / 2);
            context.restore();
        }

        // 2. 右边起始线 (Start Line)
        if (latestX >= left - 60 * ratio && latestX <= left + plotWidth + 60 * ratio)
        {
            if (latestX >= left && latestX <= left + plotWidth)
            {
                context.save();
                context.beginPath();
                context.strokeStyle = "rgba(168, 85, 247, 0.9)";
                context.lineWidth = 1.4 * ratio;
                context.setLineDash([4 * ratio, 3 * ratio]);
                context.moveTo(latestX, top);
                context.lineTo(latestX, height - bottom);
                context.stroke();
                context.restore();
            }

            // 紫色胶囊
            context.save();
            const endLabel = "0 ms";
            context.font = `bold ${9.5 * ratio}px "JetBrains Mono", monospace`;
            const endLabelWidth = context.measureText(endLabel).width + 10 * ratio;
            const labelHeight = 16 * ratio;
            const endLabelX = this.clamp(latestX - endLabelWidth / 2, left, left + plotWidth - endLabelWidth);
            const labelY = height - bottom + 3 * ratio;

            context.fillStyle = "#A855F7";
            this.roundRect(context, endLabelX, labelY, endLabelWidth, labelHeight, 3 * ratio);
            context.fill();

            context.fillStyle = "#FFFFFF";
            context.textAlign = "center";
            context.textBaseline = "middle";
            context.fillText(endLabel, endLabelX + endLabelWidth / 2, labelY + labelHeight / 2);
            context.restore();
        }

        // 绘制双击固定的 VOFA+ Delta 差值测量 (Marker A / Marker B)
        this.drawDeltaMeasurement(samples, minimum, maximum, { left, right, top, bottom, plotWidth, plotHeight, ratio });

        // 绘制十字光标与数据点吸附同心圆圈
        this.drawHover(samples, minimum, maximum, { left, right, top, bottom, plotWidth, plotHeight, ratio });
    }

    roundRect(ctx, x, y, width, height, radius)
    {
        ctx.beginPath();
        ctx.moveTo(x + radius, y);
        ctx.lineTo(x + width - radius, y);
        ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
        ctx.lineTo(x + width, y + height - radius);
        ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
        ctx.lineTo(x + radius, y + height);
        ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
        ctx.lineTo(x, y + radius);
        ctx.quadraticCurveTo(x, y, x + radius, y);
        ctx.closePath();
    }

    drawHover(samples, minimum, maximum, geometry)
    {
        if (!this.hoverPoint || this.hoverRegion !== "plot" || samples.length === 0 || !this.tooltip)
        {
            if (this.tooltip) { this.tooltip.style.display = "none"; }
            return;
        }

        const xCss = this.clamp(this.hoverPoint.x, geometry.left / geometry.ratio, (this.canvas.width - geometry.right) / geometry.ratio);
        const yCss = this.clamp(this.hoverPoint.y, geometry.top / geometry.ratio, (this.canvas.height - geometry.bottom) / geometry.ratio);
        const targetRelTime = this.viewStartMs + ((xCss - (geometry.left / geometry.ratio)) / (geometry.plotWidth / geometry.ratio)) * (this.viewEndMs - this.viewStartMs);
        const buffer = this.getBufferTimeRange();
        const latestMs = buffer.hasData ? buffer.latestMs : 0;

        let sample = samples[0];
        for (const candidate of samples)
        {
            const rel = candidate.timeMs - latestMs;
            if (Math.abs(rel - targetRelTime) < Math.abs((sample.timeMs - latestMs) - targetRelTime))
            {
                sample = candidate;
            }
        }

        const snappedRel = sample.timeMs - latestMs;
        const snappedX = geometry.left + ((snappedRel - this.viewStartMs) /
            Math.max(1e-12, this.viewEndMs - this.viewStartMs)) * geometry.plotWidth;

        const context = this.context;
        context.save();
        context.setLineDash([4 * geometry.ratio, 4 * geometry.ratio]);
        context.strokeStyle = "rgba(100, 116, 139, 0.45)";
        context.beginPath();
        context.moveTo(snappedX, geometry.top); context.lineTo(snappedX, this.canvas.height - geometry.bottom);
        context.moveTo(geometry.left, yCss * geometry.ratio); context.lineTo(this.canvas.width - geometry.right, yCss * geometry.ratio);
        context.stroke();
        context.restore();

        const cursorValue = maximum - (maximum - minimum) * ((yCss - (geometry.top / geometry.ratio)) / (geometry.plotHeight / geometry.ratio));
        const lines = [`时间: ${this.formatTime(snappedRel)}`, `Y 光标: ${this.formatAxisValue(cursorValue)}`];

        // 寻找距离鼠标 Y 最近的通道进行高亮吸附
        let closestCh = -1;
        let minDiff = Infinity;

        for (let ch = 0; ch < this.channelCount; ch++)
        {
            if (this.channelVisible[ch] && ch < sample.values.length)
            {
                const val = sample.values[ch];
                const name = this.channelNames[ch] || `CH${ch + 1}`;
                lines.push(`${name}: ${Number.isFinite(val) ? val.toFixed(4) : "--"}`);

                if (Number.isFinite(val))
                {
                    const diff = Math.abs(val - cursorValue);
                    if (diff < minDiff)
                    {
                        minDiff = diff;
                        closestCh = ch;
                    }
                }
            }
        }

        // 绘制 VOFA+ 经典曲线数据点吸附高亮圆圈 (Point Snap Ring)
        context.save();
        for (let ch = 0; ch < this.channelCount; ch++)
        {
            if (this.channelVisible[ch] && ch < sample.values.length)
            {
                const val = sample.values[ch];
                if (Number.isFinite(val))
                {
                    const pointY = geometry.top + ((maximum - val) / Math.max(1e-12, maximum - minimum)) * geometry.plotHeight;
                    const chColor = this.colors[ch % this.colors.length];

                    if (ch === closestCh)
                    {
                        // 焦点通道：高亮大同心圆环 + 外发光
                        context.shadowColor = chColor;
                        context.shadowBlur = 8 * geometry.ratio;
                        context.strokeStyle = chColor;
                        context.lineWidth = 2.5 * geometry.ratio;
                        context.beginPath();
                        context.arc(snappedX, pointY, 6.5 * geometry.ratio, 0, Math.PI * 2);
                        context.stroke();

                        // 实体中心白色小圆点
                        context.shadowBlur = 0;
                        context.fillStyle = "#FFFFFF";
                        context.beginPath();
                        context.arc(snappedX, pointY, 2.5 * geometry.ratio, 0, Math.PI * 2);
                        context.fill();
                    }
                    else
                    {
                        // 其他可见通道：小实体圆点
                        context.fillStyle = chColor;
                        context.beginPath();
                        context.arc(snappedX, pointY, 3.5 * geometry.ratio, 0, Math.PI * 2);
                        context.fill();
                    }
                }
            }
        }
        context.restore();

        this.tooltip.textContent = lines.join("\n");
        this.tooltip.style.display = "block";
        const tooltipWidth = 190;
        const tooltipHeight = 36 + lines.length * 15;
        this.tooltip.style.left = `${Math.max(4, xCss + 14 + tooltipWidth > this.canvas.clientWidth ? xCss - tooltipWidth - 10 : xCss + 14)}px`;
        this.tooltip.style.top = `${Math.max(4, yCss + 14 + tooltipHeight > this.canvas.clientHeight ? yCss - tooltipHeight - 8 : yCss + 14)}px`;
    }

    drawDeltaMeasurement(samples, minimum, maximum, geometry)
    {
        if (!this.markerA && !this.markerB) { return; }

        const context = this.context;
        const ratio = geometry.ratio;
        const buffer = this.getBufferTimeRange();
        const latestMs = buffer.hasData ? buffer.latestMs : 0;
        const viewSpan = Math.max(1e-12, this.viewEndMs - this.viewStartMs);
        const ySpan = Math.max(1e-12, maximum - minimum);

        const getMarkerPos = marker =>
        {
            if (!marker) { return null; }
            const relMs = marker.timeMs - latestMs;
            const x = geometry.left + ((relMs - this.viewStartMs) / viewSpan) * geometry.plotWidth;
            const y = geometry.top + ((maximum - marker.val) / ySpan) * geometry.plotHeight;
            return { x, y, relMs };
        };

        const posA = getMarkerPos(this.markerA);
        const posB = getMarkerPos(this.markerB);

        // 1. 绘制单个 Marker (竖向引导线 + 同心圈 + 标签)
        const renderMarkerBadge = (pos, marker, labelColor, badgeBg) =>
        {
            if (!pos) { return; }
            context.save();

            // 竖向高亮虚线
            context.setLineDash([3 * ratio, 3 * ratio]);
            context.strokeStyle = labelColor;
            context.lineWidth = 1.2 * ratio;
            context.beginPath();
            context.moveTo(pos.x, geometry.top);
            context.lineTo(pos.x, this.canvas.height - geometry.bottom);
            context.stroke();

            // 同心圆圈
            context.setLineDash([]);
            context.shadowColor = labelColor;
            context.shadowBlur = 8 * ratio;
            context.fillStyle = labelColor;
            context.beginPath();
            context.arc(pos.x, pos.y, 7 * ratio, 0, Math.PI * 2);
            context.fill();

            context.shadowBlur = 0;
            context.fillStyle = "#FFFFFF";
            context.beginPath();
            context.arc(pos.x, pos.y, 3 * ratio, 0, Math.PI * 2);
            context.fill();

            // 标签徽章 [A / B]
            const text = `[${marker.label}] ${marker.chName}: ${marker.val.toFixed(3)}`;
            context.font = `bold ${11 * ratio}px "JetBrains Mono", Consolas, monospace`;
            const textWidth = context.measureText(text).width;
            const badgeW = textWidth + 12 * ratio;
            const badgeH = 18 * ratio;
            const badgeX = this.clamp(pos.x - badgeW / 2, geometry.left, geometry.left + geometry.plotWidth - badgeW);
            const badgeY = Math.max(geometry.top + 4 * ratio, pos.y - badgeH - 8 * ratio);

            context.fillStyle = badgeBg;
            this.roundRect(context, badgeX, badgeY, badgeW, badgeH, 4 * ratio);
            context.fill();
            context.strokeStyle = labelColor;
            context.lineWidth = 1 * ratio;
            context.stroke();

            context.fillStyle = "#FFFFFF";
            context.textAlign = "center";
            context.textBaseline = "middle";
            context.fillText(text, badgeX + badgeW / 2, badgeY + badgeH / 2);
            context.restore();
        };

        if (this.markerA) { renderMarkerBadge(posA, this.markerA, "#EF4444", "rgba(220, 38, 38, 0.9)"); }
        if (this.markerB) { renderMarkerBadge(posB, this.markerB, "#0284C7", "rgba(2, 132, 199, 0.9)"); }

        // 2. 当 Marker A 与 Marker B 同时存在时，绘制直角三角形虚线与 Delta 差值卡片
        if (posA && posB && this.markerA && this.markerB)
        {
            context.save();

            // A 到 B 连线
            context.strokeStyle = "#F59E0B";
            context.lineWidth = 2 * ratio;
            context.beginPath();
            context.moveTo(posA.x, posA.y);
            context.lineTo(posB.x, posB.y);
            context.stroke();

            // 直角三角形辅助虚线 (水平 + 垂直)
            context.setLineDash([4 * ratio, 3 * ratio]);
            context.strokeStyle = "rgba(245, 158, 11, 0.65)";
            context.lineWidth = 1.2 * ratio;
            context.beginPath();
            context.moveTo(posA.x, posA.y);
            context.lineTo(posB.x, posA.y); // 水平线
            context.lineTo(posB.x, posB.y); // 垂直线
            context.stroke();
            context.restore();

            // 计算物理差值
            const dtMs = Math.abs(this.markerB.timeMs - this.markerA.timeMs);
            const freq = dtMs > 0 ? (1000 / dtMs) : 0;
            const dy = this.markerB.val - this.markerA.val;
            const slope = dtMs > 0 ? (dy / dtMs) : 0;

            // 绘制精美毛玻璃 Delta 差值测量看板 (居中或在连线上方)
            context.save();
            const cardLines = [
                `ΔX: ${dtMs.toFixed(3)} ms (${freq.toFixed(2)} Hz)`,
                `ΔY: ${dy >= 0 ? "+" : ""}${dy.toFixed(4)}`,
                `斜率: ${slope.toFixed(4)} /ms`
            ];
            const title = "VOFA+ Delta 差值测量";

            context.font = `bold ${10 * ratio}px "JetBrains Mono", Consolas, monospace`;
            let maxW = context.measureText(title).width;
            context.font = `600 ${11 * ratio}px "JetBrains Mono", Consolas, monospace`;
            cardLines.forEach(l => { maxW = Math.max(maxW, context.measureText(l).width); });

            const cardW = maxW + 24 * ratio;
            const cardH = 20 * ratio + cardLines.length * 15 * ratio + 8 * ratio;
            const midX = (posA.x + posB.x) / 2;
            const midY = (posA.y + posB.y) / 2;

            let cardX = this.clamp(midX - cardW / 2, geometry.left + 8 * ratio, geometry.left + geometry.plotWidth - cardW - 8 * ratio);
            let cardY = midY - cardH - 12 * ratio;
            if (cardY < geometry.top + 8 * ratio)
            {
                cardY = Math.min(this.canvas.height - geometry.bottom - cardH - 8 * ratio, midY + 14 * ratio);
            }

            // 卡片背景与投影
            context.shadowColor = "rgba(15, 23, 42, 0.15)";
            context.shadowBlur = 12 * ratio;
            context.fillStyle = "rgba(15, 23, 42, 0.88)";
            this.roundRect(context, cardX, cardY, cardW, cardH, 6 * ratio);
            context.fill();

            context.shadowBlur = 0;
            context.strokeStyle = "rgba(245, 158, 11, 0.8)";
            context.lineWidth = 1.2 * ratio;
            context.stroke();

            // 标题
            context.fillStyle = "#FBBF24";
            context.font = `bold ${10 * ratio}px -apple-system, "JetBrains Mono", sans-serif`;
            context.textAlign = "left";
            context.textBaseline = "top";
            context.fillText(title, cardX + 10 * ratio, cardY + 8 * ratio);

            // 分割线
            context.strokeStyle = "rgba(255, 255, 255, 0.15)";
            context.beginPath();
            context.moveTo(cardX + 8 * ratio, cardY + 22 * ratio);
            context.lineTo(cardX + cardW - 8 * ratio, cardY + 22 * ratio);
            context.stroke();

            // 内容
            context.fillStyle = "#FFFFFF";
            context.font = `600 ${11 * ratio}px "JetBrains Mono", Consolas, monospace`;
            cardLines.forEach((line, idx) =>
            {
                context.fillText(line, cardX + 10 * ratio, cardY + 28 * ratio + idx * 15 * ratio);
            });

            context.restore();
        }
    }

    exportCsv()
    {
        if (this.samples.length === 0)
        {
            throw new Error("当前没有可导出的波形数据");
        }
        const names = this.channelNames.slice(0, this.channelCount);
        const header = ["sample", "time_ms", ...names];
        const rows = [header.join(",")];

        for (let i = this.sampleHead; i < this.samples.length; i++)
        {
            const s = this.samples[i];
            rows.push([s.index, s.timeMs, ...s.values].join(","));
        }

        const blob = new Blob(["\uFEFF" + rows.join("\r\n")], { type: "text/csv;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = `SerialPlotter_${new Date().toISOString().replace(/[:.]/g, "-")}.csv`;
        link.click();
        URL.revokeObjectURL(url);
    }
}

window.UniversalPlotter = UniversalPlotter;
