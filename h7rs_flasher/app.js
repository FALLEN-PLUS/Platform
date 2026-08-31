let resources = [];
let activeResource = null;
let flasher = new SerialFlasher();
let packageBuffer = null;
let isFlashing = false;

// DOM Elements
const fileInput = document.getElementById('fileInput');
const animationInput = document.getElementById('animationInput');
const appendFramesInput = document.getElementById('appendFramesInput');
const btnAddImage = document.getElementById('btnAddImage');
const btnAddAnimation = document.getElementById('btnAddAnimation');
const videoInput = document.getElementById('videoInput');
const btnAddVideo = document.getElementById('btnAddVideo');
const resourceList = document.getElementById('resourceList');
const paramPanel = document.getElementById('paramPanel');
const previewInfo = document.getElementById('previewInfo');
const lcdCanvas = document.getElementById('lcdCanvas');
const ctx = lcdCanvas.getContext('2d');
const rulerTop = document.getElementById('rulerTop');
const rulerLeft = document.getElementById('rulerLeft');
const previewGrid = document.getElementById('previewGrid');
const previewScroll = document.getElementById('previewScroll');
const lcdWidthInput = document.getElementById('lcdWidth');
const lcdHeightInput = document.getElementById('lcdHeight');
const previewZoomInput = document.getElementById('previewZoom');
const previewZoomValue = document.getElementById('previewZoomValue');
const resourceSizeLabel = document.getElementById('resourceSizeLabel');

const pId = document.getElementById('paramId');
const pWidth = document.getElementById('paramWidth');
const pHeight = document.getElementById('paramHeight');
const pX = document.getElementById('paramX');
const pY = document.getElementById('paramY');
const pScaleMode = document.getElementById('paramScaleMode');
const pBgColor = document.getElementById('paramBgColor');
const pFps = document.getElementById('paramFps');
const paramTitle = document.getElementById('paramTitle');
const animationParams = document.getElementById('animationParams');
const frameInfo = document.getElementById('frameInfo');
const frameList = document.getElementById('frameList');
const btnPreviewToggle = document.getElementById('btnPreviewToggle');
const btnAppendFrames = document.getElementById('btnAppendFrames');
const btnFrameUp = document.getElementById('btnFrameUp');
const btnFrameDown = document.getElementById('btnFrameDown');
const btnFrameDelete = document.getElementById('btnFrameDelete');
const btnFrameReverse = document.getElementById('btnFrameReverse');
const btnDelete = document.getElementById('btnDelete');
const btnPositionOrigin = document.getElementById('btnPositionOrigin');

const btnExport = document.getElementById('btnExport');
const btnConnect = document.getElementById('btnConnect');
const btnFlash = document.getElementById('btnFlash');
const btnAbort = document.getElementById('btnAbort');
const elPackageSize = document.getElementById('packageSize');
const capacityFill = document.getElementById('capacityFill');
const elConnection = document.getElementById('connectionIndicator');
const elConnectionDot = document.getElementById('connectionDot');
const emptyResourceHint = document.getElementById('emptyResourceHint');
const bgColorHex = document.getElementById('bgColorHex');
const videoDialog = document.getElementById('videoDialog');
const videoInfo = document.getElementById('videoInfo');
const videoPreview = document.getElementById('videoPreview');
const videoStart = document.getElementById('videoStart');
const videoEnd = document.getElementById('videoEnd');
const videoExtractFps = document.getElementById('videoExtractFps');
const videoWidth = document.getElementById('videoWidth');
const videoHeight = document.getElementById('videoHeight');
const videoScaleMode = document.getElementById('videoScaleMode');
const videoBgColor = document.getElementById('videoBgColor');
const videoEstimate = document.getElementById('videoEstimate');
const btnVideoCreate = document.getElementById('btnVideoCreate');
const btnVideoCancel = document.getElementById('btnVideoCancel');

let selectedVideo = null;
let selectedVideoUrl = null;
let isExtractingVideo = false;
let lcdWidth = 280;
let lcdHeight = 240;
let previewZoom = 1.5;

function loadDisplaySettings() {
    const savedWidth = Number(localStorage.getItem('h7rs.lcdWidth'));
    const savedHeight = Number(localStorage.getItem('h7rs.lcdHeight'));
    const savedZoom = Number(localStorage.getItem('h7rs.previewZoom'));

    if (Number.isInteger(savedWidth) && savedWidth >= 1 && savedWidth <= 4096) lcdWidth = savedWidth;
    if (Number.isInteger(savedHeight) && savedHeight >= 1 && savedHeight <= 4096) lcdHeight = savedHeight;
    if (Number.isFinite(savedZoom) && savedZoom >= 0.25 && savedZoom <= 3) previewZoom = savedZoom;
}

function saveDisplaySettings() {
    localStorage.setItem('h7rs.lcdWidth', String(lcdWidth));
    localStorage.setItem('h7rs.lcdHeight', String(lcdHeight));
    localStorage.setItem('h7rs.previewZoom', String(previewZoom));
}

function updateDisplayGeometry() {
    const displayWidth = Math.round(lcdWidth * previewZoom);
    const displayHeight = Math.round(lcdHeight * previewZoom);
    const canvasContainer = lcdCanvas.parentElement;

    lcdCanvas.width = lcdWidth;
    lcdCanvas.height = lcdHeight;
    lcdCanvas.style.width = `${displayWidth}px`;
    lcdCanvas.style.height = `${displayHeight}px`;
    canvasContainer.style.width = `${displayWidth}px`;
    canvasContainer.style.height = `${displayHeight}px`;

    rulerTop.width = displayWidth;
    rulerTop.height = 20;
    rulerLeft.width = 30;
    rulerLeft.height = displayHeight;
    previewGrid.style.gridTemplateColumns = `30px ${displayWidth}px`;
    previewGrid.style.gridTemplateRows = `20px ${displayHeight}px`;

    const resBadge = document.getElementById('lcdResolutionBadge');
    if (resBadge) resBadge.textContent = `${lcdWidth}×${lcdHeight}`;

    lcdWidthInput.value = lcdWidth;
    lcdHeightInput.value = lcdHeight;
    previewZoomInput.value = Math.round(previewZoom * 100);
    previewZoomValue.textContent = `${Math.round(previewZoom * 100)}%`;
    resourceSizeLabel.textContent = `目标宽高 (最大 ${lcdWidth}×${lcdHeight})`;
    pWidth.max = lcdWidth;
    pHeight.max = lcdHeight;
    pX.min = 1 - lcdWidth;
    pX.max = lcdWidth - 1;
    pY.min = 1 - lcdHeight;
    pY.max = lcdHeight - 1;
    videoWidth.max = lcdWidth;
    videoHeight.max = lcdHeight;

    drawRulers();
    drawPreview();
}

function applyLcdSize() {
    const width = Number(lcdWidthInput.value);
    const height = Number(lcdHeightInput.value);
    if (!Number.isInteger(width) || !Number.isInteger(height) ||
        width < 1 || width > 4096 || height < 1 || height > 4096) {
        lcdWidthInput.value = lcdWidth;
        lcdHeightInput.value = lcdHeight;
        return;
    }

    lcdWidth = width;
    lcdHeight = height;
    resources.forEach(resource => {
        resource.error = validateResourceSettings(resource);
        if (!resource.error && !resource.data) {
            /* LCD重新放大后，仅重建之前因尺寸无效而清掉的数据。 */
            updateResource(resource);
        }
    });
    saveDisplaySettings();
    updateDisplayGeometry();
    renderList();
    updateGlobalState();
}

function setPreviewZoom(percent) {
    const nextPercent = Math.max(25, Math.min(300, Math.round(percent / 5) * 5));
    previewZoom = nextPercent / 100;
    saveDisplaySettings();
    updateDisplayGeometry();
}

loadDisplaySettings();

function releaseSelectedVideo() {
    if (selectedVideo) {
        selectedVideo.pause();
        selectedVideo.removeAttribute('src');
        selectedVideo.load();
        selectedVideo = null;
    }
    if (selectedVideoUrl) {
        URL.revokeObjectURL(selectedVideoUrl);
        selectedVideoUrl = null;
    }
}

// Serial Callbacks
flasher.onLog = (msg) => console.log("[Serial]", msg);
flasher.onError = (msg) => {
    elFlashStatus.textContent = msg;
    elFlashStatus.className = "status-instruction text-danger";
};
flasher.onProgress = (percent, msg) => {
    elFlashProgress.textContent = `进度: ${percent}%`;
    elFlashStatus.textContent = msg;
    elFlashStatus.className = "status-instruction text-success";
};
flasher.onConnectionChange = (connected) => {
    if (connected) {
        btnConnect.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg><span>断开连接</span>`;
        btnConnect.className = "btn-connect-ready connected";
        elConnection.textContent = "已连接";
        elConnectionDot.className = "status-dot online";
    } else {
        btnConnect.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M5 12h14"></path><path d="M12 5l7 7-7 7"></path></svg><span>连接板卡</span>`;
        btnConnect.className = "btn-connect-ready";
        elConnection.textContent = "未连接";
        elConnectionDot.className = "status-dot offline";
    }
    updateGlobalState();
};

// Events
btnAddImage.addEventListener('click', () => fileInput.click());
btnAddAnimation.addEventListener('click', () => animationInput.click());
btnAddVideo.addEventListener('click', () => videoInput.click());
fileInput.addEventListener('change', async (e) => {
    const files = e.target.files;
    for (const file of files) {
        try {
            const img = await ImageProcessor.loadFromFile(file);
            const id = findNextId();
            const res = {
                type: 'image',
                id: id,
                name: file.name,
                img: img,
                width: Math.min(img.width, lcdWidth),
                height: Math.min(img.height, lcdHeight),
                scaleMode: 'fit',
                bgColor: '#000000',
                defaultX: 0,
                defaultY: 0,
                error: null
            };
            resources.push(res);
            updateResource(res);
        } catch (err) {
            alert(`加载图片 ${file.name} 失败`);
        }
    }
    fileInput.value = '';
    renderList();
    updateGlobalState();
    if (resources.length > 0 && !activeResource) {
        selectResource(resources[resources.length - 1]);
    }
});

animationInput.addEventListener('change', async (e) => {
    const files = Array.from(e.target.files).sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));

    if (files.length === 0) return;
    if (resources.some(resource => resource.id === 101)) {
        alert('动画资源 ID 101 已存在，请先删除原动画资源');
        animationInput.value = '';
        return;
    }

    try {
        const frames = [];
        for (const file of files) {
            frames.push(await ImageProcessor.loadFromFile(file));
        }

        const firstFrame = frames[0];
        const res = {
            type: 'animation',
            /* 当前H7的IMAGE测试页面固定使用动画资源ID 101。 */
            id: 101,
            name: `${files[0].name} 等${files.length}帧`,
            frames: frames,
            frameNames: files.map(file => file.name),
            width: Math.min(firstFrame.width, lcdWidth),
            height: Math.min(firstFrame.height, lcdHeight),
            fps: 10,
            intervalMs: 100,
            frameCount: frames.length,
            scaleMode: 'fit',
            bgColor: '#000000',
            defaultX: 0,
            defaultY: 0,
            previewFrame: 0,
            previewPlaying: true,
            error: null
        };
        resources.push(res);
        updateResource(res);
        renderList();
        updateGlobalState();
        selectResource(res);
    } catch (err) {
        alert(`加载动画帧失败: ${err.message}`);
    }

    animationInput.value = '';
});

function waitForVideoEvent(video, eventName, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
        let timeoutId;
        const onEvent = () => {
            cleanup();
            resolve();
        };
        const onError = () => {
            cleanup();
            reject(new Error('浏览器无法解码该视频'));
        };
        const cleanup = () => {
            clearTimeout(timeoutId);
            video.removeEventListener(eventName, onEvent);
            video.removeEventListener('error', onError);
        };
        video.addEventListener(eventName, onEvent, { once: true });
        video.addEventListener('error', onError, { once: true });
        timeoutId = setTimeout(() => {
            cleanup();
            reject(new Error(`等待视频事件 ${eventName} 超时`));
        }, timeoutMs);
    });
}

async function seekVideo(video, time) {
    if (Math.abs(video.currentTime - time) >= 0.001) {
        const seekPending = waitForVideoEvent(video, 'seeked');
        video.currentTime = time;
        await seekPending;
    }

    /* 视频已经挂在窗口内，等待一次页面绘制后再固定当前解码帧。 */
    await new Promise(resolve => requestAnimationFrame(resolve));
}

function getCurrentPayloadSize() {
    return resources.reduce((sum, res) => sum + (res.data ? res.data.length : 0), 0);
}

function getVideoSettings() {
    const start = Number(videoStart.value);
    const end = Number(videoEnd.value);
    const fps = Number(videoExtractFps.value);
    const width = Number(videoWidth.value);
    const height = Number(videoHeight.value);
    const duration = end - start;
    const frameCount = duration > 0 && fps > 0 ? Math.ceil(duration * fps) : 0;
    const bytes = frameCount * width * height * 2;
    return { start, end, fps, width, height, duration, frameCount, bytes };
}

function updateVideoEstimate() {
    if (!selectedVideo) return;
    const value = getVideoSettings();
    const remaining = 4 * 1024 * 1024 - 0x1000 - getCurrentPayloadSize();
    const valid = value.start >= 0 && value.end > value.start &&
        value.end <= selectedVideo.duration && Number.isInteger(value.fps) &&
        value.fps >= 1 && value.fps <= 30 && Number.isInteger(value.width) &&
        Number.isInteger(value.height) && value.width >= 1 && value.width <= lcdWidth &&
        value.height >= 1 && value.height <= lcdHeight &&
        value.frameCount <= 65535 && value.bytes <= remaining;

    videoEstimate.textContent = `${value.frameCount} 帧，播放约 ${(value.frameCount / Math.max(1, value.fps)).toFixed(2)} 秒，占用 ${formatBytes(value.bytes)}；剩余 ${formatBytes(Math.max(0, remaining))}`;
    videoEstimate.className = valid ? 'text-success' : 'text-danger';
    btnVideoCreate.disabled = !valid;
}

videoInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (resources.some(resource => resource.id === 101)) {
        alert('动画资源 ID 101 已存在，请先删除原动画资源');
        videoInput.value = '';
        return;
    }

    releaseSelectedVideo();
    selectedVideoUrl = URL.createObjectURL(file);
    selectedVideo = videoPreview;
    selectedVideo.preload = 'auto';
    selectedVideo.muted = true;
    selectedVideo.src = selectedVideoUrl;
    selectedVideo.load();
    videoInfo.textContent = `正在加载 ${file.name}`;
    videoDialog.showModal();

    try {
        await waitForVideoEvent(selectedVideo, 'loadedmetadata');
        if (selectedVideo.readyState < 2) {
            await waitForVideoEvent(selectedVideo, 'loadeddata');
        }
        const defaultEnd = Math.min(selectedVideo.duration, 3);
        videoStart.value = '0';
        videoEnd.value = defaultEnd.toFixed(2);
        videoInfo.textContent = `${file.name}，${selectedVideo.videoWidth}×${selectedVideo.videoHeight}，${selectedVideo.duration.toFixed(2)} 秒`;
        updateVideoEstimate();
    } catch (err) {
        videoDialog.close();
        alert(err.message);
        releaseSelectedVideo();
    }
    videoInput.value = '';
});

[videoStart, videoEnd, videoExtractFps, videoWidth, videoHeight].forEach(input =>
    input.addEventListener('input', updateVideoEstimate));

[lcdWidthInput, lcdHeightInput].forEach(input => input.addEventListener('change', applyLcdSize));
previewZoomInput.addEventListener('input', () => setPreviewZoom(Number(previewZoomInput.value)));
previewScroll.addEventListener('wheel', (event) => {
    event.preventDefault();
    setPreviewZoom(previewZoom * 100 + (event.deltaY < 0 ? 5 : -5));
}, { passive: false });

btnVideoCancel.addEventListener('click', () => {
    videoDialog.close();
    releaseSelectedVideo();
});

videoDialog.addEventListener('cancel', (event) => {
    if (isExtractingVideo) {
        /* 抽帧中关闭窗口会留下后台任务，因此必须等当前抽帧流程自然结束。 */
        event.preventDefault();
        return;
    }
    releaseSelectedVideo();
});

btnVideoCreate.addEventListener('click', async () => {
    if (!selectedVideo) return;
    if (resources.some(resource => resource.id === 101)) {
        videoEstimate.textContent = '动画资源 ID 101 已存在，请先删除原动画资源';
        videoEstimate.className = 'text-danger';
        return;
    }
    const value = getVideoSettings();
    btnVideoCreate.disabled = true;
    btnVideoCancel.disabled = true;
    isExtractingVideo = true;
    let extractionFailed = false;

    try {
        const frames = [];
        const frameNames = [];
        for (let i = 0; i < value.frameCount; i++) {
            const time = Math.min(value.end - 0.001, value.start + i / value.fps);
            await seekVideo(selectedVideo, time);
            const bitmap = await createImageBitmap(selectedVideo);
            try {
                const processed = ImageProcessor.process(bitmap, value.width, value.height,
                    videoScaleMode.value, videoBgColor.value);
                frames.push(processed.canvas);
            } finally {
                bitmap.close();
            }
            frameNames.push(`video_${String(i + 1).padStart(4, '0')}_${time.toFixed(3)}s`);
            videoEstimate.textContent = `正在抽帧 ${i + 1} / ${value.frameCount}`;
        }

        const res = {
            type: 'animation', id: 101, name: `视频动画 ${value.frameCount}帧`,
            frames, frameNames, width: value.width, height: value.height,
            fps: value.fps, intervalMs: Math.max(1, Math.round(1000 / value.fps)),
            frameCount: frames.length, scaleMode: 'stretch', bgColor: videoBgColor.value,
            defaultX: Math.round((lcdWidth - value.width) / 2),
            defaultY: Math.round((lcdHeight - value.height) / 2),
            previewFrame: 0, previewPlaying: true, error: null
        };
        resources.push(res);
        updateResource(res);
        renderList();
        updateGlobalState();
        selectResource(res);
        videoDialog.close();
        releaseSelectedVideo();
    } catch (err) {
        extractionFailed = true;
        videoEstimate.textContent = `抽帧失败: ${err.message}`;
        videoEstimate.className = 'text-danger';
    } finally {
        isExtractingVideo = false;
        btnVideoCancel.disabled = false;
        if (selectedVideo && !extractionFailed) {
            updateVideoEstimate();
        } else if (selectedVideo) {
            /* 保留失败原因的同时恢复重试入口。 */
            btnVideoCreate.disabled = false;
        }
    }
});

window.addEventListener('beforeunload', releaseSelectedVideo);

appendFramesInput.addEventListener('change', async (e) => {
    if (!activeResource || activeResource.type !== 'animation') return;

    const files = Array.from(e.target.files).sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
    try {
        for (const file of files) {
            activeResource.frames.push(await ImageProcessor.loadFromFile(file));
            activeResource.frameNames.push(file.name);
        }
        activeResource.previewFrame = 0;
        refreshActiveAnimation();
    } catch (err) {
        alert(`追加动画帧失败: ${err.message}`);
    }
    appendFramesInput.value = '';
});

function findNextId(startId = 100) {
    let id = startId;
    while (resources.find(r => r.id === id)) id++;
    return id;
}

function formatBytes(bytes) {
    if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
    if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${bytes} B`;
}

function validateResourceSettings(res) {
    if (res.width > lcdWidth || res.height > lcdHeight || res.width < 1 || res.height < 1) {
        return `尺寸超过 ${lcdWidth}×${lcdHeight} 或小于 1`;
    }
    if (res.defaultX >= lcdWidth || res.defaultY >= lcdHeight ||
        res.defaultX + res.width <= 0 || res.defaultY + res.height <= 0) {
        return '资源默认位置完全超出LCD范围';
    }
    if (resources.filter(item => item.id === res.id).length > 1) {
        return "ID 冲突";
    }
    if (res.type === 'animation' &&
        (!Number.isInteger(res.fps) || res.fps < 1 || res.fps > 30)) {
        return "帧率必须为 1～30 FPS";
    }
    return null;
}

function updateResource(res) {
    res.error = validateResourceSettings(res);
    if (res.error) {
        res.data = null;
        res.previewCanvas = null;
        return;
    }

    if (!res.error && res.type === 'animation') {
        res.frameCount = res.frames.length;
        res.intervalMs = Math.max(1, Math.round(1000 / res.fps));
        res.previewCanvases = [];
        const frameSize = res.width * res.height * 2;
        res.data = new Uint8Array(frameSize * res.frameCount);

        res.frames.forEach((frame, index) => {
            const result = ImageProcessor.process(frame, res.width, res.height, res.scaleMode, res.bgColor);
            res.previewCanvases.push(result.canvas);
            res.data.set(result.data, index * frameSize);
        });
        res.previewCanvas = res.previewCanvases[0];
    } else if (!res.error) {
        const result = ImageProcessor.process(res.img, res.width, res.height, res.scaleMode, res.bgColor);
        res.previewCanvas = result.canvas;
        res.data = result.data;
    }
}

function renderList() {
    resourceList.innerHTML = '';
    if (resources.length === 0) {
        if (emptyResourceHint) emptyResourceHint.style.display = 'flex';
        return;
    }
    if (emptyResourceHint) emptyResourceHint.style.display = 'none';

    resources.sort((a, b) => a.id - b.id);
    resources.forEach(res => {
        const li = document.createElement('li');
        li.className = 'resource-item';
        if (activeResource === res) li.classList.add('active');
        if (res.error) li.classList.add('error');
        
        const isAnim = res.type === 'animation';
        const typeTag = isAnim ? 'ANIM' : 'IMG';
        const infoText = isAnim ? `${res.frameCount}帧 · ${res.fps}FPS` : `${res.width}×${res.height}`;
        
        const titleGroup = document.createElement('div');
        titleGroup.style.cssText = 'display:flex;align-items:center;gap:7px;overflow:hidden;';

        const typeBadge = document.createElement('span');
        typeBadge.className = 'chip-badge';
        typeBadge.style.cssText = `font-size:9.5px;padding:1px 5px;${isAnim ? 'color:var(--purple);background:var(--purple-bg);border-color:var(--purple-border);' : ''}`;
        typeBadge.textContent = `${typeTag} ${res.id}`;

        const nameLabel = document.createElement('span');
        nameLabel.style.cssText = 'font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
        nameLabel.title = res.name;
        // Why: 文件名来自用户本地文件，必须作为纯文本插入，不能进入 innerHTML。
        nameLabel.textContent = res.name;

        const infoLabel = document.createElement('span');
        infoLabel.style.cssText = 'font-size:10px;color:var(--text-muted);font-family:var(--font-mono);flex-shrink:0;';
        infoLabel.textContent = infoText;

        titleGroup.append(typeBadge, nameLabel);
        li.append(titleGroup, infoLabel);
        if (res.error) {
            const errorMark = document.createElement('span');
            errorMark.title = res.error;
            errorMark.style.cssText = 'color:var(--danger);font-weight:bold;margin-left:4px;';
            errorMark.textContent = '⚠️';
            li.appendChild(errorMark);
        }
        
        li.addEventListener('click', () => selectResource(res));
        resourceList.appendChild(li);
    });
}

function selectResource(res) {
    activeResource = res;
    renderList();
    
    const overviewPanel = document.getElementById('overviewPanel');
    if (res) {
        if (overviewPanel) overviewPanel.style.display = 'none';
        paramPanel.style.display = 'flex';
        paramTitle.textContent = res.type === 'animation' ? '动画参数' : '图片参数';
        animationParams.style.display = res.type === 'animation' ? 'block' : 'none';
        pId.value = res.id;
        pWidth.value = res.width;
        pHeight.value = res.height;
        pX.value = res.defaultX || 0;
        pY.value = res.defaultY || 0;
        pScaleMode.value = res.scaleMode;
        pBgColor.value = res.bgColor;
        if (bgColorHex) bgColorHex.textContent = res.bgColor.toUpperCase();
        if (res.type === 'animation') {
            pFps.value = res.fps;
            renderFrameList();
            updateAnimationInfo(res);
            btnPreviewToggle.textContent = res.previewPlaying ? '暂停预览' : '播放预览';
        }
        
        drawPreview();
    } else {
        paramPanel.style.display = 'none';
        if (overviewPanel) overviewPanel.style.display = 'flex';
        ctx.clearRect(0, 0, lcdCanvas.width, lcdCanvas.height);
        previewInfo.innerHTML = `<span class="info-dot"></span><span>${lcdWidth} × ${lcdHeight} LCD · 缩放 ${Math.round(previewZoom * 100)}% · RGB565: 0 B</span>`;
        updateOverviewStats();
    }
}

function renderFrameList(selectedIndex = null) {
    frameList.innerHTML = '';
    if (!activeResource || activeResource.type !== 'animation') return;

    activeResource.frameNames.forEach((name, index) => {
        const option = document.createElement('option');
        option.value = index;
        option.textContent = `${index + 1}. ${name}`;
        frameList.appendChild(option);
    });

    const index = selectedIndex === null ? activeResource.previewFrame : selectedIndex;
    frameList.selectedIndex = Math.min(index, activeResource.frameCount - 1);
}

function updateAnimationInfo(res) {
    const frameSize = res.width * res.height * 2;
    const duration = res.fps > 0 ? res.frameCount / res.fps : 0;
    frameInfo.textContent = `${res.frameCount} 帧，${duration.toFixed(2)} 秒；单帧 ${formatBytes(frameSize)}，合计 ${formatBytes(frameSize * res.frameCount)}`;
}

function refreshActiveAnimation(selectedIndex = null) {
    if (!activeResource || activeResource.type !== 'animation') return;
    updateResource(activeResource);
    if (selectedIndex !== null) {
        activeResource.previewFrame = Math.max(0, Math.min(selectedIndex, activeResource.frameCount - 1));
    }
    renderFrameList(activeResource.previewFrame);
    updateAnimationInfo(activeResource);
    renderList();
    drawPreview();
    updateGlobalState();
}

function swapFrames(res, first, second) {
    [res.frames[first], res.frames[second]] = [res.frames[second], res.frames[first]];
    [res.frameNames[first], res.frameNames[second]] = [res.frameNames[second], res.frameNames[first]];
}

btnAppendFrames.addEventListener('click', () => appendFramesInput.click());

btnFrameUp.addEventListener('click', () => {
    const index = frameList.selectedIndex;
    if (!activeResource || index <= 0) return;
    swapFrames(activeResource, index, index - 1);
    refreshActiveAnimation(index - 1);
});

btnFrameDown.addEventListener('click', () => {
    const index = frameList.selectedIndex;
    if (!activeResource || index < 0 || index >= activeResource.frameCount - 1) return;
    swapFrames(activeResource, index, index + 1);
    refreshActiveAnimation(index + 1);
});

btnFrameDelete.addEventListener('click', () => {
    const index = frameList.selectedIndex;
    if (!activeResource || index < 0) return;
    if (activeResource.frameCount <= 1) {
        alert('动画至少需要保留1帧');
        return;
    }
    activeResource.frames.splice(index, 1);
    activeResource.frameNames.splice(index, 1);
    refreshActiveAnimation(Math.min(index, activeResource.frames.length - 1));
});

btnFrameReverse.addEventListener('click', () => {
    if (!activeResource || activeResource.type !== 'animation') return;
    activeResource.frames.reverse();
    activeResource.frameNames.reverse();
    refreshActiveAnimation(0);
});

frameList.addEventListener('change', () => {
    if (!activeResource || frameList.selectedIndex < 0) return;
    activeResource.previewFrame = frameList.selectedIndex;
    drawPreview();
});

btnPreviewToggle.addEventListener('click', () => {
    if (!activeResource || activeResource.type !== 'animation') return;
    activeResource.previewPlaying = !activeResource.previewPlaying;
    btnPreviewToggle.textContent = activeResource.previewPlaying ? '暂停预览' : '播放预览';
    lastAnimationPreviewTime = 0;
});

function drawPreview() {
    ctx.clearRect(0, 0, lcdCanvas.width, lcdCanvas.height);
    
    // 极简浅色玻璃风格：屏幕本底为完全透明，仅当有像素时显示
    // (不再绘制厚重的物理液晶黑底色)

    if (activeResource && activeResource.previewCanvas) {
        const previewCanvas = activeResource.type === 'animation'
            ? activeResource.previewCanvases[activeResource.previewFrame || 0]
            : activeResource.previewCanvas;
        ctx.save();
        ctx.translate(activeResource.defaultX || 0, activeResource.defaultY || 0);
        ctx.drawImage(previewCanvas, 0, 0, activeResource.width, activeResource.height);
        
        ctx.strokeStyle = '#0071E3';
        ctx.lineWidth = Math.max(1, 1.5 / previewZoom);
        ctx.strokeRect(-1, -1, activeResource.width + 2, activeResource.height + 2);

        const handleSize = Math.max(5, 8 / previewZoom);
        const halfHandle = handleSize / 2;
        const handles = [
            [0, 0],
            [activeResource.width, 0],
            [0, activeResource.height],
            [activeResource.width, activeResource.height]
        ];
        ctx.fillStyle = '#FFFFFF';
        ctx.strokeStyle = '#0071E3';
        ctx.lineWidth = 1.5;
        for (const [handleX, handleY] of handles) {
            ctx.fillRect(handleX - halfHandle, handleY - halfHandle, handleSize, handleSize);
            ctx.strokeRect(handleX - halfHandle, handleY - halfHandle, handleSize, handleSize);
        }
        ctx.restore();
        
        if (activeResource.type === 'animation') {
            previewInfo.innerHTML = `<span class="info-dot"></span><span>动画预览：${activeResource.previewFrame + 1} / ${activeResource.frameCount} 帧 · ${activeResource.fps} FPS · RGB565: ${activeResource.data.length} B</span>`;
        } else {
            previewInfo.innerHTML = `<span class="info-dot"></span><span>画布坐标: (${activeResource.defaultX}, ${activeResource.defaultY}) · RGB565: ${activeResource.data.length} B</span>`;
        }
    } else {
        // 极简空状态：只绘制微弱的优雅辅助线
        ctx.save();
        const cx = Math.round(lcdWidth / 2);
        const cy = Math.round(lcdHeight / 2);

        // 十字中心极简虚线
        ctx.strokeStyle = 'rgba(100, 116, 139, 0.2)';
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(cx, 10); ctx.lineTo(cx, lcdHeight - 10);
        ctx.moveTo(10, cy); ctx.lineTo(lcdWidth - 10, cy);
        ctx.stroke();

        // 中心极其微弱的双环
        ctx.setLineDash([]);
        ctx.strokeStyle = 'rgba(100, 116, 139, 0.3)';
        ctx.beginPath();
        ctx.arc(cx, cy, 24, 0, Math.PI * 2);
        ctx.stroke();

        // 浅色玻璃感胶囊
        const text = `${lcdWidth} × ${lcdHeight}`;
        ctx.font = '500 10.5px "Inter", "SF Pro Display", sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        
        const metrics = ctx.measureText(text);
        const padX = 10, padY = 5;
        const pillW = metrics.width + padX * 2;
        const pillH = 22;
        
        ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
        ctx.strokeStyle = 'rgba(226, 232, 240, 0.9)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        if (ctx.roundRect) {
            ctx.roundRect(cx - pillW / 2, cy - pillH / 2, pillW, pillH, 11);
        } else {
            ctx.rect(cx - pillW / 2, cy - pillH / 2, pillW, pillH);
        }
        ctx.fill();
        ctx.stroke();

        ctx.fillStyle = '#475569';
        ctx.fillText(text, cx, cy);
        ctx.restore();

        previewInfo.innerHTML = `<span class="info-dot"></span><span>${lcdWidth} × ${lcdHeight} 画布 · 缩放 ${Math.round(previewZoom * 100)}% · RGB565: 0 B</span>`;
    }
}

// 画布对象编辑：图片内部拖动位置，四角控制点调整导入资源的目标尺寸。
let canvasEdit = null;

function getCanvasPoint(event) {
    const rect = lcdCanvas.getBoundingClientRect();
    return {
        x: (event.clientX - rect.left) * lcdWidth / rect.width,
        y: (event.clientY - rect.top) * lcdHeight / rect.height
    };
}

function getResizeHandle(point) {
    if (!activeResource) return null;

    const x = activeResource.defaultX;
    const y = activeResource.defaultY;
    const width = activeResource.width;
    const height = activeResource.height;
    const hitRadius = Math.max(5, 10 / previewZoom);
    const handles = [
        { name: 'nw', x: x, y: y },
        { name: 'ne', x: x + width, y: y },
        { name: 'sw', x: x, y: y + height },
        { name: 'se', x: x + width, y: y + height }
    ];

    return handles.find(handle =>
        Math.abs(point.x - handle.x) <= hitRadius &&
        Math.abs(point.y - handle.y) <= hitRadius)?.name || null;
}

function isPointInsideResource(point) {
    if (!activeResource) return false;
    return point.x >= activeResource.defaultX &&
        point.x <= activeResource.defaultX + activeResource.width &&
        point.y >= activeResource.defaultY &&
        point.y <= activeResource.defaultY + activeResource.height;
}

function getResourceAspectRatio(resource) {
    const source = resource.type === 'animation' ? resource.frames?.[0] : resource.img;
    const sourceWidth = source?.videoWidth || source?.naturalWidth || source?.width;
    const sourceHeight = source?.videoHeight || source?.naturalHeight || source?.height;
    return sourceWidth > 0 && sourceHeight > 0 ? sourceWidth / sourceHeight : resource.width / resource.height;
}

function resizeActiveResource(point) {
    const edit = canvasEdit;
    const leftHandle = edit.handle.includes('w');
    const topHandle = edit.handle.includes('n');
    let width = Math.max(1, Math.abs(point.x - edit.anchorX));
    let height = Math.max(1, Math.abs(point.y - edit.anchorY));

    width = Math.min(lcdWidth, Math.round(width));
    height = Math.min(lcdHeight, Math.round(height));

    if (activeResource.scaleMode === 'fit') {
        const ratio = edit.aspectRatio;
        if (width / height > ratio) {
            width = Math.max(1, Math.round(height * ratio));
        } else {
            height = Math.max(1, Math.round(width / ratio));
        }
        if (width > lcdWidth) {
            width = lcdWidth;
            height = Math.max(1, Math.round(width / ratio));
        }
        if (height > lcdHeight) {
            height = lcdHeight;
            width = Math.max(1, Math.round(height * ratio));
        }
    }

    activeResource.width = width;
    activeResource.height = height;
    activeResource.defaultX = leftHandle ? edit.anchorX - width : edit.anchorX;
    activeResource.defaultY = topHandle ? edit.anchorY - height : edit.anchorY;

    activeResource.defaultX = Math.max(1 - width, Math.min(lcdWidth - 1, activeResource.defaultX));
    activeResource.defaultY = Math.max(1 - height, Math.min(lcdHeight - 1, activeResource.defaultY));
    pWidth.value = width;
    pHeight.value = height;
    pX.value = activeResource.defaultX;
    pY.value = activeResource.defaultY;
}

lcdCanvas.addEventListener('mousedown', (e) => {
    if (!activeResource || isFlashing) return;
    e.preventDefault();
    const point = getCanvasPoint(e);
    const handle = getResizeHandle(point);

    if (handle) {
        const leftHandle = handle.includes('w');
        const topHandle = handle.includes('n');
        canvasEdit = {
            mode: 'resize',
            handle,
            anchorX: leftHandle ? activeResource.defaultX + activeResource.width : activeResource.defaultX,
            anchorY: topHandle ? activeResource.defaultY + activeResource.height : activeResource.defaultY,
            aspectRatio: getResourceAspectRatio(activeResource)
        };
        lcdCanvas.style.cursor = `${handle}-resize`;
    } else if (isPointInsideResource(point)) {
        canvasEdit = {
            mode: 'move',
            offsetX: point.x - activeResource.defaultX,
            offsetY: point.y - activeResource.defaultY
        };
        lcdCanvas.style.cursor = 'grabbing';
    }
});

lcdCanvas.addEventListener('mousemove', (e) => {
    if (!activeResource || isFlashing) return;
    const point = getCanvasPoint(e);

    if (!canvasEdit) {
        const handle = getResizeHandle(point);
        lcdCanvas.style.cursor = handle ? `${handle}-resize` :
            (isPointInsideResource(point) ? 'grab' : 'default');
        return;
    }

    if (canvasEdit.mode === 'resize') {
        resizeActiveResource(point);
    } else {
        activeResource.defaultX = Math.max(1 - activeResource.width,
            Math.min(lcdWidth - 1, Math.round(point.x - canvasEdit.offsetX)));
        activeResource.defaultY = Math.max(1 - activeResource.height,
            Math.min(lcdHeight - 1, Math.round(point.y - canvasEdit.offsetY)));
    }
    pX.value = activeResource.defaultX;
    pY.value = activeResource.defaultY;
    drawPreview();
});

function finishCanvasEdit() {
    if (!canvasEdit || !activeResource) return;
    const resized = canvasEdit.mode === 'resize';
    canvasEdit = null;
    lcdCanvas.style.cursor = 'grab';

    /* 尺寸变化松手后才转换RGB565，动画不会在拖动过程中反复处理全部帧。 */
    if (resized) updateResource(activeResource);
    renderList();
    drawPreview();
    updateGlobalState();
}

lcdCanvas.addEventListener('mouseup', finishCanvasEdit);

lcdCanvas.addEventListener('mouseleave', () => {
    finishCanvasEdit();
});

// Param changes
function onParamChange(event) {
    if (!activeResource) return;
    
    activeResource.id = parseInt(pId.value) || 0;
    activeResource.width = parseInt(pWidth.value) || 0;
    activeResource.height = parseInt(pHeight.value) || 0;
    activeResource.defaultX = parseInt(pX.value) || 0;
    activeResource.defaultY = parseInt(pY.value) || 0;
    activeResource.scaleMode = pScaleMode.value;
    activeResource.bgColor = pBgColor.value;
    if (activeResource.type === 'animation') {
        activeResource.fps = parseInt(pFps.value) || 0;
        activeResource.previewFrame = 0;
    }

    if (event && event.target === pFps && activeResource.type === 'animation') {
        activeResource.error = validateResourceSettings(activeResource);
        if (!activeResource.error) {
            activeResource.intervalMs = Math.max(1, Math.round(1000 / activeResource.fps));
        }
        updateAnimationInfo(activeResource);
        renderList();
        drawPreview();
        updateGlobalState();
        return;
    }

    if (event && (event.target === pId || event.target === pX || event.target === pY)) {
        /* ID和坐标只改变目录，不需要重新转换可能很大的RGB565动画数据。 */
        resources.forEach(resource => {
            resource.error = validateResourceSettings(resource);
            if (!resource.error && !resource.data) {
                updateResource(resource);
            }
        });
        renderList();
        drawPreview();
        updateGlobalState();
        return;
    }

    // Check all resources for ID conflicts
    resources.forEach(r => updateResource(r));

    if (activeResource.type === 'animation' && activeResource.fps > 0) {
        updateAnimationInfo(activeResource);
    }
    
    renderList();
    drawPreview();
    updateGlobalState();
}

[pId, pWidth, pHeight, pX, pY, pScaleMode, pBgColor, pFps].forEach(el => {
    el.addEventListener('change', onParamChange);
    el.addEventListener('input', onParamChange);
});

function setResourceAlignment(horizontal, vertical) {
    if (!activeResource) return;

    if (horizontal === 'left') activeResource.defaultX = 0;
    else if (horizontal === 'center') activeResource.defaultX = Math.round((lcdWidth - activeResource.width) / 2);
    else activeResource.defaultX = lcdWidth - activeResource.width;

    if (vertical === 'top') activeResource.defaultY = 0;
    else if (vertical === 'middle') activeResource.defaultY = Math.round((lcdHeight - activeResource.height) / 2);
    else activeResource.defaultY = lcdHeight - activeResource.height;

    pX.value = activeResource.defaultX;
    pY.value = activeResource.defaultY;
    drawPreview();
    updateGlobalState();
}

document.querySelectorAll('[data-align]').forEach(button => {
    button.addEventListener('click', () => {
        const [vertical, horizontal] = button.dataset.align === 'center'
            ? ['middle', 'center'] : button.dataset.align.split('-');
        setResourceAlignment(horizontal, vertical);
    });
});

btnPositionOrigin.addEventListener('click', () => {
    if (!activeResource) return;
    activeResource.defaultX = 0;
    activeResource.defaultY = 0;
    pX.value = 0;
    pY.value = 0;
    drawPreview();
    updateGlobalState();
});

function drawRulers() {
    const top = rulerTop.getContext('2d');
    const left = rulerLeft.getContext('2d');
    top.clearRect(0, 0, rulerTop.width, rulerTop.height);
    left.clearRect(0, 0, rulerLeft.width, rulerLeft.height);
    
    // 背景由 CSS 毛玻璃控制，这里仅绘制刻度和文字
    
    top.fillStyle = '#64748B';
    left.fillStyle = '#64748B';
    top.strokeStyle = 'rgba(100, 116, 139, 0.2)';
    left.strokeStyle = 'rgba(100, 116, 139, 0.2)';
    top.lineWidth = 1;
    left.lineWidth = 1;
    top.font = '500 9.5px "Inter", "JetBrains Mono", sans-serif';
    left.font = '500 9.5px "Inter", "JetBrains Mono", sans-serif';
    top.textBaseline = 'top';
    left.textBaseline = 'middle';

    /* 低倍率下增大逻辑刻度间距，保证网页上的刻度至少约20像素，不会挤成一团。 */
    const logicalStep = Math.max(20, Math.ceil(20 / previewZoom / 20) * 20);
    const labelStep = logicalStep * 2;
    for (let x = 0; x <= lcdWidth; x += logicalStep) {
        const displayX = Math.round(x * previewZoom);
        top.beginPath();
        top.moveTo(displayX, 20);
        top.lineTo(displayX, x % labelStep === 0 ? 7 : 13);
        top.stroke();
        if (x < lcdWidth && x % labelStep === 0) {
            top.fillText(String(x), displayX + 2, 2);
        }
    }
    for (let y = 0; y <= lcdHeight; y += logicalStep) {
        const displayY = Math.round(y * previewZoom);
        left.beginPath();
        left.moveTo(30, displayY);
        left.lineTo(y % labelStep === 0 ? 15 : 22, displayY);
        left.stroke();
        if (y < lcdHeight && y % labelStep === 0) {
            left.fillText(String(y), 2, displayY);
        }
    }
}
updateDisplayGeometry();

let lastAnimationPreviewTime = 0;
function updateAnimationPreview(now) {
    if (activeResource && activeResource.type === 'animation' &&
        activeResource.previewPlaying && activeResource.previewCanvases &&
        activeResource.previewCanvases.length > 0) {
        if (lastAnimationPreviewTime === 0 || now - lastAnimationPreviewTime >= activeResource.intervalMs) {
            activeResource.previewFrame = (activeResource.previewFrame + 1) % activeResource.frameCount;
            frameList.selectedIndex = activeResource.previewFrame;
            lastAnimationPreviewTime = now;
            drawPreview();
        }
    } else {
        lastAnimationPreviewTime = 0;
    }
    requestAnimationFrame(updateAnimationPreview);
}
requestAnimationFrame(updateAnimationPreview);

btnDelete.addEventListener('click', () => {
    if (!activeResource) return;
    resources = resources.filter(r => r !== activeResource);
    selectResource(resources.length > 0 ? resources[0] : null);
    updateGlobalState();
});

function updateGlobalState() {
    const slotSize = 4 * 1024 * 1024;
    let hasError = false;
    let totalPayload = 0;
    
    for (const res of resources) {
        if (res.error) hasError = true;
        if (res.data) totalPayload += res.data.length;
    }
    
    const totalSize = 0x1000 + totalPayload; // DIR_SIZE + data
    const sizeStr = formatBytes(totalSize);
    const remaining = Math.max(0, slotSize - totalSize);
    const usedPercent = Math.min(100, totalSize / slotSize * 100);

    capacityFill.style.width = `${usedPercent.toFixed(1)}%`;
    capacityFill.style.backgroundColor = usedPercent >= 90 ? '#DC2626' :
                                         usedPercent >= 70 ? '#D97706' : '#059669';

    if (activeResource && activeResource.type === 'animation') {
        const frameSize = activeResource.width * activeResource.height * 2;
        const moreFrames = frameSize > 0 ? Math.floor(remaining / frameSize) : 0;
        capacityDetail.textContent = `剩余 ${formatBytes(remaining)}，还可追加约 ${moreFrames} 帧`;
    } else {
        capacityDetail.textContent = `剩余 ${formatBytes(remaining)}，已用 ${usedPercent.toFixed(1)}%`;
    }
    
    if (totalSize > 4 * 1024 * 1024) {
        hasError = true;
        elPackageSize.textContent = `包大小: ${sizeStr} / 4 MB (超限!)`;
        elPackageSize.className = "capacity-title text-danger";
    } else {
        elPackageSize.textContent = `包大小: ${sizeStr} / 4 MB`;
        elPackageSize.className = "capacity-title";
    }
    
    if (resources.length === 0) hasError = true;

    try {
        if (!hasError) {
            packageBuffer = PackageBuilder.build(resources, lcdWidth, lcdHeight);
        } else {
            packageBuffer = null;
        }
    } catch (e) {
        hasError = true;
        packageBuffer = null;
        elFlashStatus.textContent = e.message;
        elFlashStatus.className = "status-instruction text-danger";
    }

    const canAction = !hasError && packageBuffer !== null;
    btnAddImage.disabled = isFlashing;
    btnAddAnimation.disabled = isFlashing;
    btnAddVideo.disabled = isFlashing;
    fileInput.disabled = isFlashing;
    animationInput.disabled = isFlashing;
    appendFramesInput.disabled = isFlashing;
    videoInput.disabled = isFlashing;
    lcdWidthInput.disabled = isFlashing;
    lcdHeightInput.disabled = isFlashing;
    pId.disabled = isFlashing;
    pWidth.disabled = isFlashing;
    pHeight.disabled = isFlashing;
    pX.disabled = isFlashing;
    pY.disabled = isFlashing;
    pScaleMode.disabled = isFlashing;
    pBgColor.disabled = isFlashing;
    pFps.disabled = isFlashing;
    btnPreviewToggle.disabled = isFlashing;
    btnAppendFrames.disabled = isFlashing;
    btnFrameUp.disabled = isFlashing;
    btnFrameDown.disabled = isFlashing;
    btnFrameDelete.disabled = isFlashing;
    btnFrameReverse.disabled = isFlashing;
    frameList.disabled = isFlashing;
    btnPositionOrigin.disabled = isFlashing;
    document.querySelectorAll('[data-align]').forEach(button => button.disabled = isFlashing);
    btnDelete.disabled = isFlashing;
    btnConnect.disabled = isFlashing;
    btnExport.disabled = isFlashing || !canAction;
    btnFlash.disabled = isFlashing || !canAction || !flasher.isConnected;
    btnAbort.disabled = !isFlashing || !flasher.isConnected;
}

// Global actions
btnConnect.addEventListener('click', async () => {
    if (!("serial" in navigator)) {
        elFlashStatus.textContent = "当前浏览器不支持 Web Serial，请使用桌面版 Chrome 或 Edge";
        elFlashStatus.className = "status-instruction text-danger";
        return;
    }

    if (flasher.isConnected) {
        await flasher.disconnect();
    } else {
        const success = await flasher.connect();
        if (success) {
            elFlashStatus.textContent = "先进入板卡 USB UPDATE 页面并按确认，再点击开始烧录";
            elFlashStatus.className = "status-instruction text-success";
        }
    }
    updateGlobalState();
});

btnAbort.addEventListener('click', () => {
    if (!isFlashing) return;

    btnAbort.disabled = true;
    elFlashStatus.textContent = "正在中止烧录...";
    elFlashStatus.className = "status-instruction text-warning";
    flasher.cancelFlash();
});

btnExport.addEventListener('click', () => {
    if (!packageBuffer) return;
    const blob = new Blob([packageBuffer], { type: "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = "resource.h7rs";
    a.click();
    URL.revokeObjectURL(url);
});

btnFlash.addEventListener('click', async () => {
    if (!packageBuffer || !flasher.isConnected) return;

    /* 复制本次资源包，烧录过程中编辑区锁定，确保Generation和CRC修改不污染预览数据。 */
    finishCanvasEdit();
    const flashData = packageBuffer.slice();
    isFlashing = true;
    elFlashStatus.textContent = "请先在板卡USB UPDATE页面按确认，再等待网页提示";
    elFlashStatus.className = "text-success";
    updateGlobalState();

    try {
        await flasher.flash(flashData, lcdWidth, lcdHeight);
    } catch (e) {
        // Handled in onError callback
    } finally {
        isFlashing = false;
        updateGlobalState();
    }
});

if (!("serial" in navigator)) {
    elFlashStatus.textContent = "当前浏览器不支持 Web Serial，请使用桌面版 Chrome 或 Edge";
    elFlashStatus.className = "status-instruction text-danger";
    btnConnect.disabled = true;
}

function updateOverviewStats() {
    const statImgCount = document.getElementById('statImgCount');
    const statAnimCount = document.getElementById('statAnimCount');
    const statTotalFrames = document.getElementById('statTotalFrames');
    const statTotalBytes = document.getElementById('statTotalBytes');
    if (!statImgCount) return;

    let imgCount = 0;
    let animCount = 0;
    let totalFrames = 0;
    let totalPayload = 0;

    for (const res of resources) {
        if (res.type === 'animation') {
            animCount++;
            totalFrames += (res.frameCount || 0);
        } else {
            imgCount++;
        }
        if (res.data) totalPayload += res.data.length;
    }

    statImgCount.textContent = imgCount;
    statAnimCount.textContent = animCount;
    statTotalFrames.textContent = totalFrames;
    statTotalBytes.textContent = formatBytes(totalPayload);
}

const btnBackToOverview = document.getElementById('btnBackToOverview');
if (btnBackToOverview) {
    btnBackToOverview.addEventListener('click', () => {
        selectResource(null);
    });
}

const toolColorPicker = document.getElementById('toolColorPicker');
const toolHex888 = document.getElementById('toolHex888');
const toolHex565 = document.getElementById('toolHex565');
if (toolColorPicker && toolHex888 && toolHex565) {
    function updateToolColor(hex) {
        toolHex888.textContent = hex.toUpperCase();
        const r = parseInt(hex.slice(1, 3), 16);
        const g = parseInt(hex.slice(3, 5), 16);
        const b = parseInt(hex.slice(5, 7), 16);
        const r5 = (r >> 3) & 0x1F;
        const g6 = (g >> 2) & 0x3F;
        const b5 = (b >> 3) & 0x1F;
        const rgb565 = (r5 << 11) | (g6 << 5) | b5;
        toolHex565.textContent = '0x' + rgb565.toString(16).toUpperCase().padStart(4, '0');
    }
    toolColorPicker.addEventListener('input', (e) => updateToolColor(e.target.value));
    updateToolColor(toolColorPicker.value);
}

// 页面初始化渲染
renderList();
updateGlobalState();
updateOverviewStats();
