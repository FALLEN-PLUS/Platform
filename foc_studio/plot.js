"use strict";

const TELEMETRY_MODES = {
    run: [["目标速度", "Hz"], ["实际速度", "Hz"], ["目标 Iq", "A"], ["实际 Iq", "A"], ["原始角度", "deg"]],
    standby: [["U 相 ADC", "count"], ["W 相 ADC", "count"], ["原始角度", "deg"], ["母线电压", "V"], ["Motor ID", ""]],
    calibration: [["目标速度", "Hz"], ["实际速度", "Hz"], ["目标 Iq", "A"], ["实际 Iq", "A"], ["标定状态", ""]],
    raw: [["CH1", ""], ["CH2", ""], ["CH3", ""], ["CH4", ""], ["CH5", ""]]
};

const TELEMETRY_TIMING = {
    run: { periodMs: 1, xPerDivMs: 200 },
    calibration: { periodMs: 10, xPerDivMs: 200 },
    standby: { periodMs: 1000, xPerDivMs: 1000 },
    raw: { periodMs: 1, xPerDivMs: 200 }
};

class TelemetryPlot
{
    constructor(canvas, legend, emptyHint, rangeLabel, tooltip, axisHint, overview)
    {
        this.canvas = canvas;
        this.context = canvas.getContext("2d");
        this.legend = legend;
        this.emptyHint = emptyHint;
        this.rangeLabel = rangeLabel;
        this.tooltip = tooltip;
        this.axisHint = axisHint;
        this.overview = overview;
        this.colors = ["#0284C7", "#059669", "#D97706", "#DC2626", "#7C3AED"];
        this.visible = [true, true, true, true, true];
        this.latestValues = [0, 0, 0, 0, 0];
        this.samples = [];
        this.sampleHead = 0;
        this.sampleIndex = 0;
        this.capacity = 10000;
        this.mode = "run";
        this.periodMs = 1;
        this.xDivisions = 10;
        this.autoAnchorRatio = 0.8;
        this.xPerDivMs = 200;
        this.viewStartMs = 0;
        this.viewEndMs = 2000;
        this.xAuto = true;
        this.paused = false;
        this.frozenSamples = null;
        this.autoScale = true;
        this.lastRange = [-1, 1];
        this.hoverPoint = null;
        this.hoverRegion = "outside";
        this.hoverChannel = null;
        this.dragState = null;
        this.overviewDrag = null;
        this.markerA = null;
        this.markerB = null;
        this.xViewNotificationPending = false;
        this.targetFps = 60;
        this.lastFrameTime = 0;

        this.onAutoScaleChange = () => {};
        this.onPausedChange = () => {};
        this.onXViewChange = () => {};

        this.resizeObserver = new ResizeObserver(() => this.resize());
        this.resizeObserver.observe(this.canvas.parentElement);
        this.bindPointerEvents();
        this.bindOverviewEvents();
        this.setMode("run", true);
        this.animationFrame = requestAnimationFrame(ts => this.drawLoop(ts));
    }

    clamp(value, minimum, maximum)
    {
        return Math.max(minimum, Math.min(maximum, value));
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
        const left = 64;
        const right = 14;
        const top = 14;
        const bottom = 40;
        return { rect, left, right, top, bottom,
            plotWidth: Math.max(1, rect.width - left - right),
            plotHeight: Math.max(1, rect.height - top - bottom) };
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
        if (!this.overview || !this.overview.container)
        {
            return;
        }
        const begin = (event, edge) =>
        {
            if (event.button !== 0)
            {
                return;
            }
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
            if (!this.overviewDrag || this.overviewDrag.pointerId !== event.pointerId)
            {
                return;
            }
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

    nextNiceXDiv(zoomIn)
    {
        const current = Math.max(0.001, this.xPerDivMs);
        const exponent = Math.floor(Math.log10(current));
        const unit = Math.pow(10, exponent);
        const normalized = current / unit;
        let next;
        if (zoomIn)
        {
            next = normalized > 5.000001 ? 5 * unit :
                normalized > 2.000001 ? 2 * unit :
                normalized > 1.000001 ? unit : 5 * unit / 10;
        }
        else
        {
            next = normalized < 1.999999 ? 2 * unit :
                normalized < 4.999999 ? 5 * unit : 10 * unit;
        }
        const minimum = Math.max(0.001, this.periodMs / 10);
        const maximum = Math.max(this.periodMs * this.capacity, TELEMETRY_TIMING[this.mode].xPerDivMs * 1000);
        return this.clamp(next, minimum, maximum);
    }

    zoomX(deltaY, pointerX, geometry)
    {
        const cursorRatio = this.clamp((pointerX - geometry.left) / geometry.plotWidth, 0, 1);
        const anchorMs = this.viewStartMs + cursorRatio * (this.viewEndMs - this.viewStartMs);
        const factor = deltaY < 0 ? 0.82 : 1.22;
        const currentSpan = Math.max(1e-6, this.viewEndMs - this.viewStartMs);
        const newSpan = this.clamp(currentSpan * factor, 0.001, 1e12);
        this.xPerDivMs = newSpan / this.xDivisions;

        // 核心理念：以鼠标所在点为绝对不动点缩放时间轴坐标系
        this.viewStartMs = anchorMs - cursorRatio * newSpan;
        this.viewEndMs = this.viewStartMs + newSpan;

        // 用户主动滚轮缩放时解除 Auto 跟随，锁定当前缩放视口
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

        if (region === "outside")
        {
            return;
        }

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

        // 用户主动拖拽时解除 Auto 跟随，锁定在当前历史视口，后台数据入队绝不干扰
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
            if (this.dragState.mode === "rubberband")
            {
                this.canvas.style.cursor = "crosshair";
            }
            else
            {
                this.canvas.style.cursor = "grabbing";
            }
            return;
        }

        if (this.hoverRegion === "x-axis")
        {
            this.canvas.style.cursor = "ew-resize";
            this.showAxisHint("X 轴时基 · 滚轮缩放 / 拖拽平移 / 双击恢复 Auto", position, geometry);
        }
        else if (this.hoverRegion === "y-axis")
        {
            this.canvas.style.cursor = "ns-resize";
            this.showAxisHint("Y 轴量程 · 滚轮缩放 / 拖拽平移 / 双击自动量程", position, geometry);
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
        if (!this.axisHint)
        {
            return;
        }
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
        if (!this.dragState || this.dragState.pointerId !== event.pointerId)
        {
            return;
        }

        const geometry = this.getGeometryCss();
        if (this.dragState.mode === "rubberband" && this.dragState.boxCurrent)
        {
            const p1 = this.getPosition({ clientX: this.dragState.startX, clientY: this.dragState.startY }, geometry);
            const p2 = this.getPosition(event, geometry);
            const boxWidth = Math.abs(p2.x - p1.x);
            const boxHeight = Math.abs(p2.y - p1.y);

            // 框选尺寸大于 10px 时触发局部放大
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
            if (!this.paused)
            {
                this.setPaused(true);
            }

            const samples = this.getVisibleSamples();
            if (samples.length > 0)
            {
                const xCss = this.clamp(pos.x, 64, this.canvas.clientWidth - 14);
                const yCss = this.clamp(pos.y, 14, this.canvas.clientHeight - 40);
                const targetRelTime = this.viewStartMs + ((xCss - 64) / Math.max(1, this.canvas.clientWidth - 78)) * (this.viewEndMs - this.viewStartMs);
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

                const [minimum, maximum] = this.computeRange(samples);
                const cursorVal = maximum - (maximum - minimum) * ((yCss - 14) / Math.max(1, this.canvas.clientHeight - 54));
                const definitions = TELEMETRY_MODES[this.mode];

                let closestCh = 0;
                let minDiff = Infinity;
                for (let ch = 0; ch < 5; ch++)
                {
                    if (this.visible[ch] && ch < closestSample.values.length)
                    {
                        const diff = Math.abs(closestSample.values[ch] - cursorVal);
                        if (diff < minDiff)
                        {
                            minDiff = diff;
                            closestCh = ch;
                        }
                    }
                }

                const pointVal = closestSample.values[closestCh];
                const markerData = {
                    timeMs: closestSample.timeMs,
                    val: pointVal,
                    ch: closestCh,
                    chName: definitions[closestCh] ? definitions[closestCh][0] : `CH${closestCh + 1}`,
                    unit: definitions[closestCh] ? definitions[closestCh][1] : "",
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
                    this.markerA = { ...markerData, label: "A" };
                    this.markerB = null;
                }
                this.dirty = true;
                return;
            }
        }

        if (region === "x-axis")
        {
            this.resetXView();
        }
        else if (region === "y-axis")
        {
            this.setAutoScale(true);
        }
    }

    clearMarkers()
    {
        this.markerA = null;
        this.markerB = null;
        this.dirty = true;
    }

    resetXView()
    {
        this.xPerDivMs = TELEMETRY_TIMING[this.mode].xPerDivMs;
        this.setPaused(false);
        this.setXAuto(true);
        this.followLatest(true);
        this.notifyXViewChange();
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

    setMode(mode, force = false)
    {
        if (!TELEMETRY_MODES[mode] || (!force && this.mode === mode))
        {
            return;
        }
        this.mode = mode;
        const timing = TELEMETRY_TIMING[mode];
        this.periodMs = timing.periodMs;
        this.xPerDivMs = timing.xPerDivMs;
        const span = this.xPerDivMs * this.xDivisions;
        // VOFA+ 相对时序：以最新采样点为 0，视口默认从 -span 到 0
        this.viewStartMs = -span;
        this.viewEndMs = 0;
        this.xAuto = true;
        const wasPaused = this.paused;
        this.paused = false;
        this.frozenSamples = null;
        this.buildLegend();
        if (wasPaused)
        {
            this.onPausedChange(false);
        }
        this.notifyXViewChange();
        this.dirty = true;
    }

    setViewBounds(startMs, endMs)
    {
        if (!Number.isFinite(startMs) || !Number.isFinite(endMs))
        {
            return;
        }
        const minimumSpan = Math.max(0.001, this.periodMs);
        if (endMs - startMs < minimumSpan)
        {
            return;
        }
        this.viewStartMs = startMs;
        this.viewEndMs = endMs;
        this.xPerDivMs = (endMs - startMs) / this.xDivisions;
        this.setPaused(true);
        this.notifyXViewChange();
        this.dirty = true;
    }

    setXAuto(enabled)
    {
        this.xAuto = enabled;
        if (enabled)
        {
            this.setPaused(false);
            const timing = TELEMETRY_TIMING[this.mode];
            if (timing)
            {
                this.xPerDivMs = timing.xPerDivMs;
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

    followLatest(force = false)
    {
        // VOFA+ 相对时序体系下：最新采样点永远是 0 原点，相对视口无需随绝对物理时间自增
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

    buildLegend()
    {
        this.legend.innerHTML = "";
        TELEMETRY_MODES[this.mode].forEach((definition, index) =>
        {
            const item = document.createElement("label");
            item.className = "channel-item";
            item.title = "双击仅显示此通道；再次双击恢复全部通道";
            const checkbox = document.createElement("input");
            checkbox.type = "checkbox";
            checkbox.checked = this.visible[index];
            checkbox.addEventListener("change", () => { this.visible[index] = checkbox.checked; this.dirty = true; });
            const name = document.createElement("span");
            name.className = "channel-name";
            name.textContent = definition[0];
            name.style.color = this.colors[index];
            const value = document.createElement("strong");
            value.className = "channel-value";
            value.dataset.channelValue = String(index);
            value.textContent = "--";
            item.addEventListener("mouseenter", () => { this.hoverChannel = index; this.dirty = true; });
            item.addEventListener("mouseleave", () => { this.hoverChannel = null; this.dirty = true; });
            item.addEventListener("dblclick", event =>
            {
                event.preventDefault();
                const restoreAll = this.visible.filter(Boolean).length === 1 && this.visible[index];
                this.visible = this.visible.map((unused, channel) => restoreAll || channel === index);
                this.buildLegend();
                this.dirty = true;
            });
            item.append(checkbox, name, value);
            this.legend.appendChild(item);
        });
        this.updateLegendValues();
    }

    updateLegendValues()
    {
        const definitions = TELEMETRY_MODES[this.mode];
        this.legend.querySelectorAll("[data-channel-value]").forEach(item =>
        {
            const index = Number(item.dataset.channelValue);
            const unit = definitions[index][1];
            item.textContent = `${this.formatChannelValue(this.latestValues[index], unit)}${unit ? " " + unit : ""}`;
        });
    }

    formatChannelValue(value, unit)
    {
        if (!Number.isFinite(value)) { return "--"; }
        if (unit === "Hz") { return value.toFixed(6); }
        if (unit === "A") { return Math.abs(value) < 0.01 ? value.toFixed(6) : value.toFixed(4); }
        if (unit === "count" || unit === "")
        {
            return Math.abs(value - Math.round(value)) < 1e-4 ? String(Math.round(value)) : value.toFixed(3);
        }
        return value.toFixed(3);
    }

    formatAxisValue(value)
    {
        const absolute = Math.abs(value);
        return absolute >= 10000 || (absolute > 0 && absolute < 0.001) ? value.toExponential(3) : value.toFixed(3);
    }

    formatTime(valueMs)
    {
        const sign = valueMs < 0 ? "-" : "";
        const absolute = Math.abs(valueMs);
        if (absolute < 1000) { return `${sign}${Number(absolute.toFixed(3))} ms`; }
        if (absolute < 60000) { return `${sign}${Number((absolute / 1000).toFixed(3))} s`; }
        return `${sign}${(absolute / 60000).toFixed(2)} min`;
    }

    addSample(values)
    {
        const safeValues = values.map(v => (Number.isFinite(v) && Math.abs(v) <= 1e9 ? v : 0));
        if (!this.paused)
        {
            this.latestValues = safeValues.slice(0, 5);
        }
        this.samples.push({ index: this.sampleIndex, timeMs: this.sampleIndex * this.periodMs, values: safeValues.slice(0, 5) });
        this.sampleIndex++;
        if (this.samples.length - this.sampleHead > this.capacity)
        {
            // Why: 1 kHz 下逐帧 splice 会持续搬移约一万个元素；逻辑头索引保持
            // 严格 10000 点容量，仅在累计出一整块旧数据后低频压缩一次。
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
            this.emptyHint.style.display = "none";
            this.dirty = true;
        }
    }

    setPaused(paused)
    {
        const changed = this.paused !== paused;
        if (!changed)
        {
            return;
        }
        if (paused)
        {
            // Why: 仅冻结坐标轴仍会让新点在窗口内部继续出现；保存完整显示快照
            // 才能同时冻结曲线、图例、光标、Y量程和范围条，而后台缓存继续接收。
            this.frozenSamples = this.getBufferedSamples();
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
        this.latestValues = [NaN, NaN, NaN, NaN, NaN];
        const span = this.xPerDivMs * this.xDivisions;
        this.viewStartMs = -span;
        this.viewEndMs = 0;
        this.hoverPoint = null;
        this.tooltip.style.display = "none";
        this.hideAxisHint();
        this.emptyHint.style.display = "grid";
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
        if (source.length <= startIndex)
        {
            return [];
        }

        const latestMs = source[source.length - 1].timeMs;
        const targetStartTime = latestMs + this.viewStartMs;
        const targetEndTime = latestMs + this.viewEndMs;

        let low = startIndex;
        let high = source.length - 1;
        let firstIdx = source.length;

        // 找到大于等于 targetStartTime 的第一个点
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

        // 找到小于等于 targetEndTime 的最后一个点
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

        // 向左右各外扩 1 个点，保证曲线在视口边缘平滑延伸
        const start = Math.max(startIndex, firstIdx - 1);
        const end = Math.min(source.length - 1, lastIdx + 1);
        if (start > end)
        {
            return [];
        }
        return source.slice(start, end + 1);
    }

    getBufferedSamples()
    {
        return this.samples.slice(this.sampleHead);
    }

    computeRange(samples)
    {
        if (!this.autoScale) { return this.lastRange; }
        let minimum = Infinity;
        let maximum = -Infinity;
        let validCount = 0;

        for (const sample of samples)
        {
            for (let channel = 0; channel < 5; channel++)
            {
                if (this.visible[channel])
                {
                    const val = sample.values[channel];
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
        this.onXViewChange({ startMs: this.viewStartMs, endMs: this.viewEndMs,
            xPerDivMs: this.xPerDivMs, periodMs: this.periodMs,
            xAuto: this.xAuto, capacity: this.capacity });
    }

    getOverviewBounds()
    {
        const capacityMs = this.periodMs * this.capacity;
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

    drawLoop(timestamp = performance.now())
    {
        if (!this.lastFrameTime)
        {
            this.lastFrameTime = timestamp;
        }

        const interval = 1000 / this.targetFps;
        const elapsed = timestamp - this.lastFrameTime;

        if (elapsed >= interval - 1.5)
        {
            if (this.dirty)
            {
                this.draw();
                this.dirty = false;
            }
            this.lastFrameTime = timestamp;
        }

        this.animationFrame = requestAnimationFrame(ts => this.drawLoop(ts));
    }

    setTargetFps(fps)
    {
        this.targetFps = fps === 30 ? 30 : 60;
        this.dirty = true;
    }

    draw()
    {
        // Why: 串口可达 1 kHz，图例和范围条只需跟随显示刷新率，数据缓存仍逐帧进行。
        this.updateLegendValues();
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
        const left = 64 * ratio;
        const right = 14 * ratio;
        const top = 14 * ratio;
        const bottom = 40 * ratio;
        const plotWidth = Math.max(1, width - left - right);
        const plotHeight = Math.max(1, height - top - bottom);
        context.clearRect(0, 0, width, height);
        
        // 旗舰级 HUD 视口底色 (纯净白晶微霜示波器工作区)
        const bgGrad = context.createLinearGradient(0, top, 0, height - bottom);
        bgGrad.addColorStop(0, "#FFFFFF");
        bgGrad.addColorStop(1, "#F8FAFC");
        context.fillStyle = bgGrad;
        context.fillRect(left, top, plotWidth, plotHeight);

        // 视口精细边框
        context.strokeStyle = "rgba(203, 213, 225, 0.8)";
        context.lineWidth = 1 * ratio;
        context.strokeRect(left, top, plotWidth, plotHeight);

        const samples = this.getVisibleSamples();
        const [minimum, maximum] = this.computeRange(samples);
        this.rangeLabel.textContent = `Y: ${this.formatAxisValue(minimum)} ～ ${this.formatAxisValue(maximum)}`;

        // 精密测控网格线与坐标刻度
        context.lineWidth = 1 * ratio;
        context.strokeStyle = "rgba(15, 23, 42, 0.06)";
        context.fillStyle = "#64748B";
        context.font = `${10 * ratio}px "JetBrains Mono", Consolas, monospace`;
        context.textAlign = "right";
        context.textBaseline = "middle";
        for (let row = 0; row <= 5; row++)
        {
            const y = top + (plotHeight * row) / 5;
            context.beginPath(); context.moveTo(left, y); context.lineTo(width - right, y); context.stroke();
            context.fillText(this.formatAxisValue(maximum - ((maximum - minimum) * row) / 5), left - 7 * ratio, y);
        }
        context.textAlign = "center";
        context.textBaseline = "top";
        for (let column = 0; column <= this.xDivisions; column++)
        {
            const x = left + (plotWidth * column) / this.xDivisions;
            context.beginPath(); context.moveTo(x, top); context.lineTo(x, height - bottom); context.stroke();
            context.fillText(this.formatTime(this.viewStartMs + this.xPerDivMs * column), x, height - bottom + 7 * ratio);
        }

        // 视口右上角 HUD 状态微标识
        context.save();
        context.font = `600 ${9.5 * ratio}px -apple-system, BlinkMacSystemFont, "Inter", sans-serif`;
        context.textAlign = "right";
        context.textBaseline = "top";
        if (this.paused)
        {
            context.fillStyle = "#F59E0B";
            context.fillText("❚❚ PAUSED", width - right - 8 * ratio, top + 6 * ratio);
        }
        else
        {
            context.fillStyle = "#34D399";
            context.fillText(`● ${this.targetFps} FPS LIVE`, width - right - 8 * ratio, top + 6 * ratio);
        }
        context.restore();

        // 5 通道激光霓虹波形绘制 (含 Canvas 2D 视口硬裁剪保护，绝不穿模)
        context.save();
        context.beginPath();
        context.rect(left, top, plotWidth, plotHeight);
        context.clip();

        const viewSpan = Math.max(1e-12, this.viewEndMs - this.viewStartMs);
        const ySpan = Math.max(1e-12, maximum - minimum);
        const buffer = this.getBufferTimeRange();
        const latestMs = buffer.hasData ? buffer.latestMs : 0;
        const capacityMs = this.periodMs * this.capacity;

        const sampleCount = samples.length;
        const useDecimation = sampleCount > plotWidth * 1.5;

        for (let channel = 0; channel < 5; channel++)
        {
            if (!this.visible[channel] || sampleCount === 0) { continue; }
            const isHovered = this.hoverChannel === channel;
            const hasFocus = this.hoverChannel !== null;
            context.save();
            context.beginPath();
            context.strokeStyle = this.colors[channel];
            context.shadowColor = this.colors[channel];
            context.shadowBlur = (isHovered ? 8 : 3.5) * ratio;

            if (hasFocus)
            {
                context.globalAlpha = isHovered ? 1.0 : 0.18;
                context.lineWidth = (isHovered ? 2.6 : 1.2) * ratio;
            }
            else
            {
                context.globalAlpha = 1.0;
                context.lineWidth = 1.6 * ratio;
            }

            if (!useDecimation)
            {
                let hasMoved = false;
                for (let index = 0; index < sampleCount; index++)
                {
                    const sample = samples[index];
                    const relTime = sample.timeMs - latestMs;
                    const x = left + ((relTime - this.viewStartMs) / viewSpan) * plotWidth;
                    const y = top + plotHeight * (1 - (sample.values[channel] - minimum) / ySpan);
                    if (!hasMoved) { context.moveTo(x, y); hasMoved = true; }
                    else { context.lineTo(x, y); }
                }
            }
            else
            {
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

                for (let index = 0; index < sampleCount; index++)
                {
                    const sample = samples[index];
                    const val = sample.values[channel];
                    const relTime = sample.timeMs - latestMs;
                    const pixelX = Math.round(((relTime - this.viewStartMs) / viewSpan) * plotWidth);

                    if (pixelX !== currentPixel)
                    {
                        flushColumn();
                        currentPixel = pixelX;
                        minVal = val;
                        maxVal = val;
                        minIdx = index;
                        maxIdx = index;
                        firstVal = val;
                        lastVal = val;
                    }
                    else
                    {
                        if (val < minVal) { minVal = val; minIdx = index; }
                        if (val > maxVal) { maxVal = val; maxIdx = index; }
                        lastVal = val;
                    }
                }
                flushColumn();
            }

            context.stroke();
            context.restore();
        }

        // 绘制 VOFA 式右键/Shift 矩形框选放大高亮视框
        if (this.dragState && this.dragState.mode === "rubberband" && this.dragState.boxCurrent)
        {
            const geometry = { rect: this.canvas.getBoundingClientRect() };
            const p1 = this.getPosition({ clientX: this.dragState.startX, clientY: this.dragState.startY }, geometry);
            const p2 = this.getPosition({ clientX: this.dragState.boxCurrent.x, clientY: this.dragState.boxCurrent.y }, geometry);
            const bx = Math.min(p1.x, p2.x) * ratio;
            const by = Math.min(p1.y, p2.y) * ratio;
            const bw = Math.abs(p1.x - p2.x) * ratio;
            const bh = Math.abs(p1.y - p2.y) * ratio;

            context.fillStyle = "rgba(0, 113, 227, 0.15)";
            context.fillRect(bx, by, bw, bh);
            context.strokeStyle = "#0071E3";
            context.lineWidth = 1.5 * ratio;
            context.setLineDash([4 * ratio, 3 * ratio]);
            context.strokeRect(bx, by, bw, bh);
        }

        context.restore();

        // VOFA+ 标志性双线标尺：左边红线（缓冲区最大容量 -capacityMs）与 右边紫线（最新采样点 0 ms）
        const firstRel = -capacityMs;
        const latestRel = 0;

        const firstX = left + ((firstRel - this.viewStartMs) / viewSpan) * plotWidth;
        const latestX = left + ((latestRel - this.viewStartMs) / viewSpan) * plotWidth;

        // 1. 左边停止线 (Stop Line - 红色虚线，标定缓冲区最大历史容量 -capacityMs)
        if (firstX >= left - 60 * ratio && firstX <= left + plotWidth + 60 * ratio)
        {
            if (firstX >= left && firstX <= left + plotWidth)
            {
                context.save();
                context.beginPath();
                context.strokeStyle = "rgba(220, 38, 38, 0.95)";
                context.lineWidth = 1.4 * ratio;
                context.setLineDash([4 * ratio, 3 * ratio]);
                context.moveTo(firstX, top);
                context.lineTo(firstX, height - bottom);
                context.stroke();
                context.restore();
            }

            // 绘制底部左边停止线红色游标胶囊标签
            context.save();
            const startLabel = this.formatTime(firstRel);
            context.font = `bold ${9.5 * ratio}px "JetBrains Mono", monospace`;
            const startLabelWidth = context.measureText(startLabel).width + 10 * ratio;
            const labelHeight = 16 * ratio;
            const startLabelX = this.clamp(firstX - startLabelWidth / 2, left, left + plotWidth - startLabelWidth);
            const labelY = height - bottom + 3 * ratio;

            context.fillStyle = "#DC2626";
            this.roundRect(context, startLabelX, labelY, startLabelWidth, labelHeight, 3 * ratio);
            context.fill();

            context.fillStyle = "#FFFFFF";
            context.textAlign = "center";
            context.textBaseline = "middle";
            context.fillText(startLabel, startLabelX + startLabelWidth / 2, labelY + labelHeight / 2);
            context.restore();
        }

        // 2. 右边起始线 (Start Line - 紫色虚线，标定最新采样原点 0 ms)
        if (latestX >= left - 60 * ratio && latestX <= left + plotWidth + 60 * ratio)
        {
            if (latestX >= left && latestX <= left + plotWidth)
            {
                context.save();
                context.beginPath();
                context.strokeStyle = "rgba(124, 58, 237, 0.95)";
                context.lineWidth = 1.4 * ratio;
                context.setLineDash([4 * ratio, 3 * ratio]);
                context.moveTo(latestX, top);
                context.lineTo(latestX, height - bottom);
                context.stroke();
                context.restore();
            }

            // 绘制底部右边起始线紫色游标胶囊标签
            context.save();
            const endLabel = "0 ms";
            context.font = `bold ${9.5 * ratio}px "JetBrains Mono", monospace`;
            const endLabelWidth = context.measureText(endLabel).width + 10 * ratio;
            const labelHeight = 16 * ratio;
            const endLabelX = this.clamp(latestX - endLabelWidth / 2, left, left + plotWidth - endLabelWidth);
            const labelY = height - bottom + 3 * ratio;

            context.fillStyle = "#7C3AED";
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
        if (!this.hoverPoint || this.hoverRegion !== "plot" || samples.length === 0)
        {
            this.tooltip.style.display = "none";
            return;
        }
        const xCss = this.clamp(this.hoverPoint.x, 64, this.canvas.clientWidth - 14);
        const yCss = this.clamp(this.hoverPoint.y, 14, this.canvas.clientHeight - 40);
        const targetRelTime = this.viewStartMs + ((xCss - 64) / Math.max(1, this.canvas.clientWidth - 78)) * (this.viewEndMs - this.viewStartMs);
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
        context.strokeStyle = "rgba(15, 23, 42, 0.4)";
        context.beginPath();
        context.moveTo(snappedX, geometry.top); context.lineTo(snappedX, this.canvas.height - geometry.bottom);
        context.moveTo(geometry.left, yCss * geometry.ratio); context.lineTo(this.canvas.width - geometry.right, yCss * geometry.ratio);
        context.stroke(); context.restore();

        const cursorValue = maximum - (maximum - minimum) * ((yCss - 14) / Math.max(1, this.canvas.clientHeight - 54));
        const definitions = TELEMETRY_MODES[this.mode];
        const lines = [`sample: ${sample.index}`, `rel_time: ${this.formatTime(snappedRel)}`, `Y cursor: ${this.formatAxisValue(cursorValue)}`];

        let closestCh = -1;
        let minDiff = Infinity;

        definitions.forEach((definition, channel) =>
        {
            if (this.visible[channel])
            {
                const val = sample.values[channel];
                lines.push(`${definition[0]}: ${this.formatChannelValue(val, definition[1])}${definition[1] ? " " + definition[1] : ""}`);

                if (Number.isFinite(val))
                {
                    const diff = Math.abs(val - cursorValue);
                    if (diff < minDiff)
                    {
                        minDiff = diff;
                        closestCh = channel;
                    }
                }
            }
        });

        // 绘制 VOFA+ 经典曲线数据点吸附高亮圆圈
        context.save();
        definitions.forEach((definition, channel) =>
        {
            if (this.visible[channel])
            {
                const val = sample.values[channel];
                if (Number.isFinite(val))
                {
                    const pointY = geometry.top + ((maximum - val) / Math.max(1e-12, maximum - minimum)) * geometry.plotHeight;
                    const chColor = this.colors[channel % this.colors.length];

                    if (channel === closestCh)
                    {
                        context.shadowColor = chColor;
                        context.shadowBlur = 8 * geometry.ratio;
                        context.strokeStyle = chColor;
                        context.lineWidth = 2.5 * geometry.ratio;
                        context.beginPath();
                        context.arc(snappedX, pointY, 6.5 * geometry.ratio, 0, Math.PI * 2);
                        context.stroke();

                        context.shadowBlur = 0;
                        context.fillStyle = "#FFFFFF";
                        context.beginPath();
                        context.arc(snappedX, pointY, 2.5 * geometry.ratio, 0, Math.PI * 2);
                        context.fill();
                    }
                    else
                    {
                        context.fillStyle = chColor;
                        context.beginPath();
                        context.arc(snappedX, pointY, 3.5 * geometry.ratio, 0, Math.PI * 2);
                        context.fill();
                    }
                }
            }
        });
        context.restore();

        this.tooltip.textContent = lines.join("\n");
        this.tooltip.style.display = "block";
        const tooltipWidth = 210;
        const tooltipHeight = 42 + lines.length * 16;
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

        const renderMarkerBadge = (pos, marker, labelColor, badgeBg) =>
        {
            if (!pos) { return; }
            context.save();

            context.setLineDash([3 * ratio, 3 * ratio]);
            context.strokeStyle = labelColor;
            context.lineWidth = 1.2 * ratio;
            context.beginPath();
            context.moveTo(pos.x, geometry.top);
            context.lineTo(pos.x, this.canvas.height - geometry.bottom);
            context.stroke();

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

            const text = `[${marker.label}] ${marker.chName}: ${marker.val.toFixed(3)}${marker.unit ? " " + marker.unit : ""}`;
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

        if (posA && posB && this.markerA && this.markerB)
        {
            context.save();
            context.strokeStyle = "#F59E0B";
            context.lineWidth = 2 * ratio;
            context.beginPath();
            context.moveTo(posA.x, posA.y);
            context.lineTo(posB.x, posB.y);
            context.stroke();

            context.setLineDash([4 * ratio, 3 * ratio]);
            context.strokeStyle = "rgba(245, 158, 11, 0.65)";
            context.lineWidth = 1.2 * ratio;
            context.beginPath();
            context.moveTo(posA.x, posA.y);
            context.lineTo(posB.x, posA.y);
            context.lineTo(posB.x, posB.y);
            context.stroke();
            context.restore();

            const dtMs = Math.abs(this.markerB.timeMs - this.markerA.timeMs);
            const freq = dtMs > 0 ? (1000 / dtMs) : 0;
            const dy = this.markerB.val - this.markerA.val;
            const slope = dtMs > 0 ? (dy / dtMs) : 0;

            context.save();
            const cardLines = [
                `ΔX: ${dtMs.toFixed(3)} ms (${freq.toFixed(2)} Hz)`,
                `ΔY: ${dy >= 0 ? "+" : ""}${dy.toFixed(4)}${this.markerB.unit ? " " + this.markerB.unit : ""}`,
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

            context.shadowColor = "rgba(15, 23, 42, 0.15)";
            context.shadowBlur = 12 * ratio;
            context.fillStyle = "rgba(15, 23, 42, 0.88)";
            this.roundRect(context, cardX, cardY, cardW, cardH, 6 * ratio);
            context.fill();

            context.shadowBlur = 0;
            context.strokeStyle = "rgba(245, 158, 11, 0.8)";
            context.lineWidth = 1.2 * ratio;
            context.stroke();

            context.fillStyle = "#FBBF24";
            context.font = `bold ${10 * ratio}px -apple-system, "JetBrains Mono", sans-serif`;
            context.textAlign = "left";
            context.textBaseline = "top";
            context.fillText(title, cardX + 10 * ratio, cardY + 8 * ratio);

            context.strokeStyle = "rgba(255, 255, 255, 0.15)";
            context.beginPath();
            context.moveTo(cardX + 8 * ratio, cardY + 22 * ratio);
            context.lineTo(cardX + cardW - 8 * ratio, cardY + 22 * ratio);
            context.stroke();

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
        if (this.samples.length === 0) { throw new Error("当前没有可导出的波形数据"); }
        const definitions = TELEMETRY_MODES[this.mode];
        const header = ["sample", "time_ms", ...definitions.map(item => `${item[0]}${item[1] ? "(" + item[1] + ")" : ""}`)];
        const rows = [header.join(",")];
        for (let index = this.sampleHead; index < this.samples.length; index++)
        {
            const sample = this.samples[index];
            rows.push([sample.index, sample.timeMs, ...sample.values].join(","));
        }
        const blob = new Blob(["\uFEFF" + rows.join("\r\n")], { type: "text/csv;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = `G3507_${this.mode}_${new Date().toISOString().replace(/[:.]/g, "-")}.csv`;
        link.click();
        URL.revokeObjectURL(url);
    }
}

window.TelemetryPlot = TelemetryPlot;
window.TELEMETRY_MODES = TELEMETRY_MODES;
window.TELEMETRY_TIMING = TELEMETRY_TIMING;
