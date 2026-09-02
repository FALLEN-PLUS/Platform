/**
 * @file    audio_studio.js
 * @brief   在线电机音乐工作站 (Audio Studio Engine & Sequential ACK Flow Control)
 * @details 支持 MP4/WebM/MP3/WAV/MIDI/RTTTL/简谱等多格式智能解析与自相关基频提取，
 *          提供逐包确认滑动窗口流控、发送代次(audioGeneration)隔离、END_STREAM 与 PLAY_FINISHED 联动
 *          以及主线程非阻塞调度。
 */

"use strict";

class AudioStudio
{
    constructor(serial, options = {})
    {
        this.serial = serial;
        this.options = options;

        // 状态变量
        this.notes = [];            // 解析出的音符序列 [{ freq: number, duration: number, time_ms: number }]
        this.totalDurationMs = 0;
        this.currentSessionId = 0;
        this.currentSeq = 0;
        this.noteIndex = 0;
        this.isPlaying = false;
        this.volumeMv = 800;        // 默认 800mV (0.8V)
        this.freeSlots = 16;
        this.playState = 0;
        this.playStartTime = 0;
        this.playheadTimer = null;
        this.audioContext = null;

        // 协议代次与等待 ACK 机制
        this.audioGeneration = 0;
        this.pendingAck = null;
        this.volumeSendTimer = null;

        // UI 元素引用
        this.elements = {};

        this.initUI();
        this.bindSerialEvents();
    }

    /* ============================================================================== */
    /* 1. UI 元素绑定与事件注册                                                         */
    /* ============================================================================== */
    initUI()
    {
        this.elements = {
            modal: document.getElementById("musicModal"),
            btnOpen: document.getElementById("btnOpenMusicModal"),
            btnClose: document.getElementById("btnCloseMusicModal"),
            dropzone: document.getElementById("musicDropzone"),
            fileInput: document.getElementById("musicFileInput"),
            fileInfoCard: document.getElementById("musicFileInfoCard"),
            fileName: document.getElementById("musicFileName"),
            fileMeta: document.getElementById("musicFileMeta"),
            videoWrapper: document.getElementById("musicVideoWrapper"),
            videoPreview: document.getElementById("musicVideoPreview"),
            canvas: document.getElementById("musicPianoRoll"),
            volSlider: document.getElementById("musicVolSlider"),
            volValue: document.getElementById("musicVolValue"),
            btnPlay: document.getElementById("btnMusicPlay"),
            btnStop: document.getElementById("btnMusicStop"),
            statusPill: document.getElementById("musicStatusPill"),
            progressText: document.getElementById("musicProgressText"),
            progressBar: document.getElementById("musicProgressBar")
        };

        if (this.elements.btnOpen)
        {
            this.elements.btnOpen.addEventListener("click", () => this.openModal());
        }
        if (this.elements.btnClose)
        {
            this.elements.btnClose.addEventListener("click", () => this.closeModal());
        }
        if (this.elements.modal)
        {
            this.elements.modal.addEventListener("click", (e) =>
            {
                if (e.target === this.elements.modal)
                {
                    this.closeModal();
                }
            });
        }

        // 文件拖拽与选择
        if (this.elements.dropzone && this.elements.fileInput)
        {
            this.elements.dropzone.addEventListener("click", () => this.elements.fileInput.click());
            this.elements.fileInput.addEventListener("change", (e) =>
            {
                if (e.target.files && e.target.files.length > 0)
                {
                    this.handleFile(e.target.files[0]);
                }
            });

            this.elements.dropzone.addEventListener("dragover", (e) =>
            {
                e.preventDefault();
                this.elements.dropzone.classList.add("drag-hover");
            });
            this.elements.dropzone.addEventListener("dragleave", () =>
            {
                this.elements.dropzone.classList.remove("drag-hover");
            });
            this.elements.dropzone.addEventListener("drop", (e) =>
            {
                e.preventDefault();
                this.elements.dropzone.classList.remove("drag-hover");
                if (e.dataTransfer.files && e.dataTransfer.files.length > 0)
                {
                    this.handleFile(e.dataTransfer.files[0]);
                }
            });
        }

        // 音量调节
        if (this.elements.volSlider && this.elements.volValue)
        {
            this.elements.volSlider.addEventListener("input", (e) =>
            {
                const val = parseInt(e.target.value, 10);
                this.volumeMv = Math.max(100, Math.min(1500, val));
                this.elements.volValue.textContent = `${(this.volumeMv / 1000).toFixed(2)} V`;
                if (this.isPlaying)
                {
                    if (this.volumeSendTimer)
                    {
                        clearTimeout(this.volumeSendTimer);
                    }
                    const gen = this.audioGeneration;
                    this.volumeSendTimer = setTimeout(() =>
                    {
                        this.volumeSendTimer = null;
                        if (this.isPlaying && this.audioGeneration === gen)
                        {
                            this.sendVolumeCommand(this.volumeMv, gen).catch(() => {});
                        }
                    }, 100);
                }
            });
        }

        // 播放与停止
        if (this.elements.btnPlay)
        {
            this.elements.btnPlay.addEventListener("click", () => this.startStreaming());
        }
        if (this.elements.btnStop)
        {
            this.elements.btnStop.addEventListener("click", () => this.stopStreaming());
        }

        // 页面卸载或刷新时触发统一停止
        window.addEventListener("beforeunload", () =>
        {
            if (this.isPlaying)
            {
                this.stopStreaming("页面关闭", true);
            }
        });
    }

    bindSerialEvents()
    {
        if (!this.serial) return;

        // 拦截 0xFA 音频应答
        this.serial.onAudioResponse = (frame) => this.handleAudioResponse(frame);
    }

    openModal()
    {
        if (this.elements.modal)
        {
            this.elements.modal.style.display = "flex";
        }
        this.drawPianoRoll();
    }

    closeModal()
    {
        if (this.elements.modal)
        {
            this.elements.modal.style.display = "none";
        }
    }

    setStatus(text, type = "idle")
    {
        if (!this.elements.statusPill) return;
        this.elements.statusPill.textContent = text;
        this.elements.statusPill.className = `status-pill pill-${type}`;
    }

    /* ============================================================================== */
    /* 2. 多格式文件导入与智能解析 (带主线程让出与长度限制)                            */
    /* ============================================================================== */
    async handleFile(file)
    {
        const ext = file.name.split(".").pop().toLowerCase();
        this.setStatus(`正在解析: ${file.name}...`, "busy");

        try
        {
            if (this.isPlaying)
            {
                await this.stopStreaming();
            }

            if (this.elements.videoPreview)
            {
                this.elements.videoPreview.pause();
                this.elements.videoPreview.src = "";
            }
            if (this.elements.videoWrapper)
            {
                this.elements.videoWrapper.style.display = "none";
            }

            if (ext === "mid" || ext === "midi")
            {
                const buffer = await file.arrayBuffer();
                this.notes = this.parseMidi(buffer);
            }
            else if (ext === "rtttl")
            {
                const text = await file.text();
                this.notes = this.parseRtttl(text);
            }
            else if (ext === "txt")
            {
                const text = await file.text();
                if (text.includes(":") && (text.includes("d=") || text.includes("b=")))
                {
                    this.notes = this.parseRtttl(text);
                }
                else
                {
                    this.notes = this.parseNumberedScore(text);
                }
            }
            else if (ext === "mp3" || ext === "wav" || ext === "ogg" || ext === "aac" || ext === "mp4" || ext === "webm")
            {
                if (ext === "mp4" || ext === "webm")
                {
                    if (this.elements.videoWrapper && this.elements.videoPreview)
                    {
                        this.elements.videoWrapper.style.display = "block";
                        this.elements.videoPreview.src = URL.createObjectURL(file);
                        this.elements.videoPreview.load();
                    }
                }
                const buffer = await file.arrayBuffer();
                this.notes = await this.extractPitchFromAudio(buffer);
            }
            else
            {
                throw new Error(`不支持的文件格式: .${ext}`);
            }

            if (!this.notes || this.notes.length === 0)
            {
                throw new Error("未能从文件中解析出有效音符");
            }

            // Why: 协议中的 duration 只有 16 位，提前拆分可避免长休止或长音被静默截断。
            this.notes = this.normalizeNotesForProtocol(this.notes);

            // 计算乐曲总时长
            this.totalDurationMs = this.notes.reduce((sum, n) => sum + n.duration, 0);

            // 更新 UI 元数据卡片
            if (this.elements.fileName)
            {
                this.elements.fileName.textContent = file.name;
            }
            if (this.elements.fileMeta)
            {
                const durSec = (this.totalDurationMs / 1000).toFixed(1);
                let hint = (ext === "mid" || ext === "midi") ? " (按统一速度解析，和弦提取最高音)" : "";
                this.elements.fileMeta.textContent = `格式: ${ext.toUpperCase()} | 音符数: ${this.notes.length} | 总时长: ${durSec} 秒${hint}`;
            }
            if (this.elements.fileInfoCard)
            {
                this.elements.fileInfoCard.style.display = "flex";
            }
            if (this.elements.btnPlay)
            {
                this.elements.btnPlay.disabled = false;
            }

            this.setStatus("乐谱就绪", "ready");
            this.drawPianoRoll();
        }
        catch (err)
        {
            console.error("Audio parse error:", err);
            this.setStatus(`解析失败: ${err.message}`, "error");
            alert(`音频解析失败: ${err.message}`);
        }
    }

    normalizeNotesForProtocol(notes)
    {
        const normalized = [];
        const maxDurationMs = 60000;

        for (const note of notes)
        {
            const freq = Math.max(0, Math.min(4000, Math.round(Number(note.freq) || 0)));
            let remaining = Math.max(1, Math.round(Number(note.duration) || 0));

            while (remaining > 0)
            {
                const duration = Math.min(remaining, maxDurationMs);
                normalized.push({ freq, duration });
                remaining -= duration;
            }
        }

        return normalized;
    }

    /* ============================================================================== */
    /* 3. MIDI 格式标准解析器 (最高旋律音提取，丢弃伴奏低音避免和弦串联)              */
    /* ============================================================================== */
    parseMidi(buffer)
    {
        const data = new Uint8Array(buffer);
        let pos = 0;

        function readStr(len)
        {
            let str = "";
            for (let i = 0; i < len; i++) str += String.fromCharCode(data[pos++]);
            return str;
        }
        function readU16() { const val = (data[pos] << 8) | data[pos + 1]; pos += 2; return val; }
        function readU32() { const val = (data[pos] << 24) | (data[pos + 1] << 16) | (data[pos + 2] << 8) | data[pos + 3]; pos += 4; return val; }
        function readVarLen()
        {
            let val = 0;
            while (true)
            {
                const b = data[pos++];
                val = (val << 7) | (b & 0x7F);
                if (!(b & 0x80)) break;
            }
            return val;
        }

        if (readStr(4) !== "MThd") throw new Error("无效的 MIDI 头部");
        const headerLen = readU32();
        const format = readU16();
        const numTracks = readU16();
        const division = readU16(); // ticks per quarter note
        pos = 14;

        let usPerQuarter = 500000; // 默认 120 BPM
        const events = [];

        for (let t = 0; t < numTracks; t++)
        {
            if (pos >= data.length) break;
            const chunkType = readStr(4);
            const chunkLen = readU32();
            const trackEnd = pos + chunkLen;
            let tick = 0;
            let runningStatus = 0;

            while (pos < trackEnd && pos < data.length)
            {
                const delta = readVarLen();
                tick += delta;

                let status = data[pos];
                if (status >= 0x80)
                {
                    runningStatus = status;
                    pos++;
                }
                else
                {
                    status = runningStatus;
                }

                const type = status & 0xF0;

                if (status === 0xFF) // Meta event
                {
                    const metaType = data[pos++];
                    const metaLen = readVarLen();
                    if (metaType === 0x51 && metaLen === 3) // Set Tempo
                    {
                        usPerQuarter = (data[pos] << 16) | (data[pos + 1] << 8) | data[pos + 2];
                    }
                    pos += metaLen;
                }
                else if (status === 0xF0 || status === 0xF7) // SysEx
                {
                    const sysexLen = readVarLen();
                    pos += sysexLen;
                }
                else if (type === 0x90) // Note On
                {
                    const note = data[pos++];
                    const vel = data[pos++];
                    events.push({ tick, type: (vel > 0 ? "on" : "off"), note, vel });
                }
                else if (type === 0x80) // Note Off
                {
                    const note = data[pos++];
                    const vel = data[pos++];
                    events.push({ tick, type: "off", note, vel });
                }
                else if (type === 0xC0 || type === 0xD0)
                {
                    pos += 1;
                }
                else
                {
                    pos += 2;
                }
            }
            pos = trackEnd;
        }

        // 按时间排序事件
        events.sort((a, b) => a.tick - b.tick);

        const msPerTick = (usPerQuarter / 1000) / division;
        const notes = [];
        const activeNotes = new Map();

        for (const ev of events)
        {
            const timeMs = Math.round(ev.tick * msPerTick);
            if (ev.type === "on")
            {
                activeNotes.set(ev.note, timeMs);
            }
            else if (ev.type === "off" && activeNotes.has(ev.note))
            {
                const startMs = activeNotes.get(ev.note);
                activeNotes.delete(ev.note);
                const duration = Math.max(40, timeMs - startMs);
                const freq = Math.round(440 * Math.pow(2, (ev.note - 69) / 12));
                if (freq >= 100 && freq <= 4000)
                {
                    notes.push({ freq, duration, time_ms: startMs });
                }
            }
        }

        // 提取最高旋律音 (和弦只保留最高音)
        notes.sort((a, b) => a.time_ms - b.time_ms);
        const sequence = [];
        let curTime = 0;

        for (let i = 0; i < notes.length; i++)
        {
            const n = notes[i];
            
            // 如果与当前音轨时间存在重合 (和弦)
            if (n.time_ms < curTime)
            {
                const last = sequence[sequence.length - 1];
                if (last && last.freq > 0)
                {
                    if (n.freq > last.freq)
                    {
                        const played = Math.max(0, n.time_ms - (curTime - last.duration));
                        if (played >= 40)
                        {
                            last.duration = played;
                            sequence.push({ freq: n.freq, duration: n.duration });
                            curTime = n.time_ms + n.duration;
                        }
                        else
                        {
                            last.freq = n.freq;
                            last.duration = n.duration;
                            curTime = n.time_ms + n.duration;
                        }
                    }
                }
                continue;
            }

            if (n.time_ms > curTime + 20)
            {
                sequence.push({ freq: 0, duration: n.time_ms - curTime });
            }

            sequence.push({ freq: n.freq, duration: n.duration });
            curTime = n.time_ms + n.duration;
        }

        return sequence;
    }

    /* ============================================================================== */
    /* 4. RTTTL (诺基亚单音铃声) 解析器                                               */
    /* ============================================================================== */
    parseRtttl(rtttlStr)
    {
        const parts = rtttlStr.trim().split(":");
        if (parts.length < 3) throw new Error("无效的 RTTTL 格式");

        let defaultDuration = 4;
        let defaultOctave = 6;
        let bpm = 63;

        const controls = parts[1].split(",");
        for (const c of controls)
        {
            const [k, v] = c.trim().split("=");
            if (k === "d") defaultDuration = parseInt(v, 10);
            if (k === "o") defaultOctave = parseInt(v, 10);
            if (k === "b") bpm = parseInt(v, 10);
        }

        const beatMs = 60000 / bpm;
        const wholeNoteMs = beatMs * 4;

        const noteMap = {
            "c": 261.63, "c#": 277.18, "d": 293.66, "d#": 311.13,
            "e": 329.63, "f": 349.23, "f#": 369.99, "g": 392.00,
            "g#": 415.30, "a": 440.00, "a#": 466.16, "b": 493.88,
            "p": 0, "h": 493.88
        };

        const notesRaw = parts[2].split(",");
        const sequence = [];

        for (let noteStr of notesRaw)
        {
            noteStr = noteStr.trim().toLowerCase();
            if (!noteStr) continue;

            let idx = 0;
            let durNum = "";
            while (idx < noteStr.length && noteStr[idx] >= '0' && noteStr[idx] <= '9')
            {
                durNum += noteStr[idx++];
            }
            const durationVal = durNum ? parseInt(durNum, 10) : defaultDuration;

            let noteName = "";
            while (idx < noteStr.length && ((noteStr[idx] >= 'a' && noteStr[idx] <= 'z') || noteStr[idx] === '#'))
            {
                noteName += noteStr[idx++];
            }

            let isDotted = false;
            if (idx < noteStr.length && noteStr[idx] === '.')
            {
                isDotted = true;
                idx++;
            }

            let octaveVal = defaultOctave;
            if (idx < noteStr.length && noteStr[idx] >= '0' && noteStr[idx] <= '9')
            {
                octaveVal = parseInt(noteStr[idx++], 10);
            }

            if (idx < noteStr.length && noteStr[idx] === '.')
            {
                isDotted = true;
            }

            let baseFreq = noteMap[noteName] !== undefined ? noteMap[noteName] : 0;
            let finalFreq = 0;
            if (baseFreq > 0)
            {
                const octaveDiff = octaveVal - 4;
                finalFreq = Math.round(baseFreq * Math.pow(2, octaveDiff));
            }

            let durationMs = Math.round(wholeNoteMs / durationVal);
            if (isDotted) durationMs = Math.round(durationMs * 1.5);

            durationMs = Math.max(40, durationMs);
            sequence.push({ freq: finalFreq, duration: durationMs });
        }

        return sequence;
    }

    /* ============================================================================== */
    /* 5. 简谱文本解析器 (Numbered Musical Notation)                                  */
    /* ============================================================================== */
    parseNumberedScore(text)
    {
        const baseFreqs = [0, 262, 294, 330, 349, 392, 440, 494];
        let bpm = 100;
        const bpmMatch = text.match(/(?:BPM|Speed|速度)\s*[:=]\s*(\d+)/i);
        if (bpmMatch) bpm = parseInt(bpmMatch[1], 10);

        const beatMs = 60000 / bpm;
        const sequence = [];
        const lines = text.split("\n");

        for (const line of lines)
        {
            const clean = line.replace(/\[.*?\]|\/\/.*|#.*/g, "").trim();
            if (!clean) continue;

            const tokens = clean.split(/\s+/);
            for (const token of tokens)
            {
                if (!token) continue;
                const m = token.match(/^([+|-]*)(\d)([.-]*)$/);
                if (m)
                {
                    const octaveMods = m[1];
                    const num = parseInt(m[2], 10);
                    const durMods = m[3];

                    if (num < 0 || num > 7) continue;

                    let freq = baseFreqs[num];
                    if (freq > 0)
                    {
                        let octaveShift = 0;
                        for (const ch of octaveMods)
                        {
                            if (ch === '+') octaveShift++;
                            if (ch === '-') octaveShift--;
                        }
                        freq = Math.round(freq * Math.pow(2, octaveShift));
                    }

                    let dur = beatMs;
                    for (const ch of durMods)
                    {
                        if (ch === '-') dur += beatMs;
                        if (ch === '.') dur *= 1.5;
                    }

                    dur = Math.max(40, Math.round(dur));
                    sequence.push({ freq, duration: dur });
                }
            }
        }

        return sequence;
    }

    /* ============================================================================== */
    /* 6. 音频/视频自相关基频提取 (限长 5min，异步让出主线程防卡死)                    */
    /* ============================================================================== */
    async extractPitchFromAudio(arrayBuffer)
    {
        if (!this.audioContext)
        {
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
        }

        this.setStatus("正在解码音频 PCM 流...", "busy");
        let audioBuffer;
        try
        {
            audioBuffer = await this.audioContext.decodeAudioData(arrayBuffer);
        }
        catch (err)
        {
            throw new Error("当前浏览器不支持该媒体音频编码或音轨格式");
        }

        const channelData = audioBuffer.getChannelData(0);
        const sampleRate = audioBuffer.sampleRate;

        // Why: 浏览器主线程执行自相关，限制到 60 秒并抽样可避免长视频分析数十亿次乘加而假死。
        const maxDurationSec = 60;
        const sampleStep = Math.max(1, Math.ceil(sampleRate / 12000));
        const analysisSampleRate = sampleRate / sampleStep;
        const maxSamples = Math.min(
            Math.floor(channelData.length / sampleStep),
            Math.floor(maxDurationSec * analysisSampleRate)
        );

        this.setStatus("正在进行自相关基频分析 (Autocorrelation)...", "busy");

        const frameSize = 1024;
        const hopSize = 512;
        const totalFrames = Math.floor((maxSamples - frameSize) / hopSize);
        const frameDurationMs = Math.round((hopSize / analysisSampleRate) * 1000);

        const rawPitches = [];

        for (let f = 0; f < totalFrames; f++)
        {
            // 每处理 20 帧让出主线程一次，保持停止按钮和进度提示可响应。
            if (f % 20 === 0)
            {
                await new Promise(r => setTimeout(r, 0));
                const pct = Math.round((f / totalFrames) * 100);
                this.setStatus(`自相关分析中: ${pct}%...`, "busy");
            }

            const offset = f * hopSize;
            let rms = 0;
            for (let i = 0; i < frameSize; i++)
            {
                const sample = channelData[(offset + i) * sampleStep];
                rms += sample * sample;
            }
            rms = Math.sqrt(rms / frameSize);

            if (rms < 0.015)
            {
                rawPitches.push(0);
                continue;
            }

            const minLag = Math.max(2, Math.floor(analysisSampleRate / 4000));
            const maxLag = Math.floor(analysisSampleRate / 100);
            let bestLag = -1;
            let bestCorr = 0;

            for (let lag = minLag; lag <= maxLag; lag++)
            {
                let corr = 0;
                for (let i = 0; i < frameSize - lag; i++)
                {
                    corr += channelData[(offset + i) * sampleStep] *
                            channelData[(offset + i + lag) * sampleStep];
                }
                if (corr > bestCorr)
                {
                    bestCorr = corr;
                    bestLag = lag;
                }
            }

            if (bestLag > 0)
            {
                const freq = Math.round(analysisSampleRate / bestLag);
                if (freq >= 100 && freq <= 4000)
                {
                    const midiNote = Math.round(69 + 12 * Math.log2(freq / 440));
                    const quantizedFreq = Math.round(440 * Math.pow(2, (midiNote - 69) / 12));
                    rawPitches.push(quantizedFreq);
                }
                else
                {
                    rawPitches.push(0);
                }
            }
            else
            {
                rawPitches.push(0);
            }
        }

        const sequence = [];
        let currentFreq = rawPitches[0] || 0;
        let currentDur = frameDurationMs;

        for (let i = 1; i < rawPitches.length; i++)
        {
            const f = rawPitches[i];
            if (f === currentFreq)
            {
                currentDur += frameDurationMs;
            }
            else
            {
                if (currentDur >= 40)
                {
                    sequence.push({ freq: currentFreq, duration: currentDur });
                }
                currentFreq = f;
                currentDur = frameDurationMs;
            }
        }
        if (currentDur >= 40)
        {
            sequence.push({ freq: currentFreq, duration: currentDur });
        }

        return sequence;
    }

    /* ============================================================================== */
    /* 7. Canvas 钢琴卷帘可视化 (Piano Roll Visualizer)                                */
    /* ============================================================================== */
    drawPianoRoll()
    {
        const canvas = this.elements.canvas;
        if (!canvas) return;
        const ctx = canvas.getContext("2d");
        const w = canvas.width = canvas.parentElement.clientWidth || 600;
        const h = canvas.height = 140;

        ctx.clearRect(0, 0, w, h);

        ctx.fillStyle = "#F5F5F7";
        ctx.fillRect(0, 0, w, h);

        if (!this.notes || this.notes.length === 0 || this.totalDurationMs === 0)
        {
            ctx.fillStyle = "#86868B";
            ctx.font = "13px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto";
            ctx.textAlign = "center";
            ctx.fillText("请拖入或选择音频/视频/MIDI文件生成音符谱线", w / 2, h / 2);
            return;
        }

        const minFreq = 130;
        const maxFreq = 2000;
        const logMin = Math.log2(minFreq);
        const logMax = Math.log2(maxFreq);

        let curTime = 0;
        for (let i = 0; i < this.notes.length; i++)
        {
            const n = this.notes[i];
            const x = (curTime / this.totalDurationMs) * w;
            const noteW = Math.max(2, (n.duration / this.totalDurationMs) * w);

            if (n.freq > 0)
            {
                const logF = Math.log2(Math.max(minFreq, Math.min(maxFreq, n.freq)));
                const norm = (logF - logMin) / (logMax - logMin);
                const y = h - (norm * (h - 20)) - 10;

                if (i < this.noteIndex)
                {
                    ctx.fillStyle = "#34C759";
                }
                else
                {
                    ctx.fillStyle = "#0071E3";
                }
                ctx.fillRect(x, y - 3, noteW, 6);
            }
            curTime += n.duration;
        }

        if (this.isPlaying)
        {
            const elapsed = Date.now() - this.playStartTime;
            const playX = Math.min(w, (elapsed / this.totalDurationMs) * w);
            ctx.strokeStyle = "#FF3B30";
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(playX, 0);
            ctx.lineTo(playX, h);
            ctx.stroke();
        }
    }

    /* ============================================================================== */
    /* 8. 在线推流与逐包确认控制循环 (Sequential ACK Pipeline)                         */
    /* ============================================================================== */
    async startStreaming()
    {
        if (!this.serial || !this.serial.isConnected)
        {
            alert("请先连接电机串口！");
            return;
        }
        if (!this.notes || this.notes.length === 0)
        {
            alert("请先导入歌曲乐谱！");
            return;
        }

        this.isPlaying = true;
        this.audioGeneration++;
        const currentGen = this.audioGeneration;

        this.currentSessionId = (Date.now() & 0xFFFF);
        this.currentSeq = 0;
        this.noteIndex = 0;
        this.freeSlots = 16;
        this.playStartTime = Date.now();

        if (this.elements.btnPlay) this.elements.btnPlay.disabled = true;
        if (this.elements.btnStop) this.elements.btnStop.disabled = false;

        this.setStatus("正在启动音乐会话...", "busy");

        try
        {
            // 1. 发送 0x01 START_PLAY 并等待确认
            const startAck = await this.sendStartSessionCommand(this.currentSessionId, currentGen);
            if (startAck.status === 5)
            {
                throw new Error("下位机母线欠压/编码器异常/校准未完成，安全锁定禁止播放！");
            }
            if (startAck.status !== 0)
            {
                throw new Error(`会话建立失败，状态码: ${startAck.status}`);
            }

            // 2. 同步音量设置
            await this.sendVolumeCommand(this.volumeMv, currentGen);

            // 3. 同步播放视频 (若有)
            if (this.elements.videoPreview && this.elements.videoPreview.src)
            {
                this.elements.videoPreview.currentTime = 0;
                this.elements.videoPreview.play().catch(() => {});
            }

            this.setStatus("推流中...", "playing");

            // 4. 启动 UI 播放指针定时刷新
            if (this.playheadTimer) clearInterval(this.playheadTimer);
            this.playheadTimer = setInterval(() =>
            {
                this.drawPianoRoll();
            }, 50);

            // 5. 启动异步逐包推流循环
            this.runStreamingLoop(currentGen);
        }
        catch (err)
        {
            console.error("Start streaming failed:", err);
            this.stopStreaming(err.message);
        }
    }

    async runStreamingLoop(gen)
    {
        while (this.noteIndex < this.notes.length)
        {
            if (this.audioGeneration !== gen || !this.isPlaying) return;

            const note = this.notes[this.noteIndex];
            const res = await this.sendNoteWithAck(this.currentSeq, note.freq, note.duration, gen);

            if (res.aborted) return;

            if (res.safetyLock)
            {
                this.stopStreaming("下位机触发急停或硬件故障，安全锁定禁止播放！");
                return;
            }
            if (res.noSession)
            {
                this.stopStreaming("下位机音频会话已失效");
                return;
            }
            if (res.seqErr)
            {
                console.warn(`Sequence 错序，下位机期望: ${res.expectedSeq}`);
                this.currentSeq = res.expectedSeq;
                this.noteIndex = Math.min(this.currentSeq, this.notes.length);
                continue;
            }

            if (res.ok)
            {
                this.noteIndex++;
                this.currentSeq = (this.currentSeq + 1) & 0xFFFF;
                this.updateProgress();
            }
            else
            {
                this.stopStreaming(`通信重试超过 3 次，推流中断：${res.error || "未收到有效 ACK"}`);
                return;
            }
        }

        // 全部音符推送完成，发送 0x05 END_STREAM 结束推流
        if (this.audioGeneration === gen && this.isPlaying)
        {
            this.setStatus("已完成推流，等待电机播放完毕...", "busy");
            try
            {
                await this.sendEndStreamCommand(gen);
            }
            catch (err)
            {
                console.warn("End stream ack error:", err);
            }
        }
    }

    async sendNoteWithAck(seq, freq, duration, gen)
    {
        let retries = 0;
        const maxRetries = 3;
        let lastError = "未收到有效 ACK";

        while (retries < maxRetries)
        {
            if (this.audioGeneration !== gen || !this.isPlaying)
            {
                return { ok: false, aborted: true };
            }

            try
            {
                const ack = await this.sendFrameWithAck(
                    this.buildNotePacket(seq, freq, duration),
                    0x02,
                    seq,
                    500,
                    gen
                );

                if (ack.status === 0)
                {
                    return { ok: true };
                }
                else if (ack.status === 4) // QUEUE_FULL
                {
                    // 队列满时留出消费时间，避免高频重发反而堵塞串口。
                    await new Promise(r => setTimeout(r, 40));
                    continue;
                }
                else if (ack.status === 3) // SEQ_ERR
                {
                    return { ok: false, seqErr: true, expectedSeq: ack.ackSeq };
                }
                else if (ack.status === 5) // SAFETY_LOCK
                {
                    return { ok: false, safetyLock: true };
                }
                else if (ack.status === 6) // NO_SESSION
                {
                    return { ok: false, noSession: true };
                }
                else
                {
                    lastError = `下位机返回状态码 ${ack.status}`;
                    retries++;
                }
            }
            catch (err)
            {
                if (this.audioGeneration !== gen || !this.isPlaying)
                {
                    return { ok: false, aborted: true };
                }
                lastError = err && err.message ? err.message : String(err);
                retries++;
            }
        }

        return { ok: false, error: lastError };
    }

    async stopStreaming(reason = null, silent = false)
    {
        this.isPlaying = false;
        this.audioGeneration++;

        if (this.pendingAck)
        {
            if (this.pendingAck.timer) clearTimeout(this.pendingAck.timer);
            this.pendingAck.reject(new Error("Playback stopped"));
            this.pendingAck = null;
        }

        if (this.volumeSendTimer)
        {
            clearTimeout(this.volumeSendTimer);
            this.volumeSendTimer = null;
        }

        if (this.playheadTimer)
        {
            clearInterval(this.playheadTimer);
            this.playheadTimer = null;
        }

        if (this.elements.videoPreview)
        {
            this.elements.videoPreview.pause();
        }

        if (this.elements.btnPlay) this.elements.btnPlay.disabled = false;
        if (this.elements.btnStop) this.elements.btnStop.disabled = true;

        if (this.serial && this.serial.isConnected)
        {
            try
            {
                await this.sendStopCommand();
            }
            catch (e) {}
        }

        if (reason && !silent)
        {
            this.setStatus(reason, "error");
            alert(reason);
        }
        else if (!silent)
        {
            this.setStatus("已停止播放", "idle");
        }

        this.drawPianoRoll();
    }

    onPlayFinished()
    {
        this.stopStreaming(null, true);
        this.setStatus("播放完成", "ready");
        if (this.elements.progressBar)
        {
            this.elements.progressBar.style.width = "100%";
        }
        if (this.elements.progressText)
        {
            this.elements.progressText.textContent = `播放完毕: 全部 ${this.notes.length} 个音符`;
        }
    }

    /* ============================================================================== */
    /* 9. ACK 应答分发与匹配 (0x80 ACK / 0x81 PLAY_FINISHED)                          */
    /* ============================================================================== */
    handleAudioResponse(frame)
    {
        if (frame.length < 10 || frame[0] !== 0xFA || frame[9] !== 0xFB) return;

        const cmd = frame[1];

        // 1. 处理 0x81 PLAY_FINISHED 主动通知
        if (cmd === 0x81)
        {
            const sessionId = frame[2] | (frame[3] << 8);
            // Why: 串口中的旧完成通知可能延迟到新播放之后，不能让它停止新 Session。
            if (this.isPlaying && sessionId === this.currentSessionId)
            {
                this.onPlayFinished();
            }
            return;
        }

        // 2. 处理 0x80 ACK
        if (cmd !== 0x80) return;

        const origCmd = frame[2];
        const status = frame[3];
        const ackSeq = frame[4] | (frame[5] << 8);
        this.freeSlots = frame[6];
        this.playState = frame[7];

        if (this.pendingAck && this.pendingAck.origCmd === origCmd)
        {
            // SEQ_ERR 返回的是下位机下一步期望序号，因此不能按当前发送序号过滤。
            if (origCmd !== 0x02 || this.pendingAck.seq === ackSeq || status === 3)
            {
                if (this.pendingAck.timer) clearTimeout(this.pendingAck.timer);
                const resolve = this.pendingAck.resolve;
                this.pendingAck = null;
                resolve({ status, ackSeq, freeSlots: this.freeSlots, playState: this.playState });
            }
        }
    }

    sendFrameWithAck(frame, origCmd, seq, timeoutMs, gen)
    {
        return new Promise((resolve, reject) =>
        {
            if (this.audioGeneration !== gen || !this.isPlaying)
            {
                reject(new Error("Generation expired"));
                return;
            }

            if (this.pendingAck)
            {
                if (this.pendingAck.timer) clearTimeout(this.pendingAck.timer);
                this.pendingAck.reject(new Error("Superseded by new request"));
            }

            const timer = setTimeout(() =>
            {
                if (this.pendingAck && this.pendingAck.gen === gen)
                {
                    this.pendingAck = null;
                    reject(new Error(`ACK Timeout for cmd 0x${origCmd.toString(16)}`));
                }
            }, timeoutMs);

            this.pendingAck = { origCmd, seq, gen, resolve, reject, timer };

            this.serial.sendAudioFrame(frame).catch(err =>
            {
                if (this.pendingAck && this.pendingAck.gen === gen)
                {
                    clearTimeout(timer);
                    this.pendingAck = null;
                    reject(err);
                }
            });
        });
    }

    updateProgress()
    {
        if (this.elements.progressText)
        {
            this.elements.progressText.textContent = `已推流: ${this.noteIndex} / ${this.notes.length} 音符`;
        }
        if (this.elements.progressBar)
        {
            const pct = this.notes.length > 0 ? (this.noteIndex / this.notes.length) * 100 : 0;
            this.elements.progressBar.style.width = `${pct.toFixed(1)}%`;
        }
    }

    /* ============================================================================== */
    /* 10. 0xFA 协议帧底层打包                                                        */
    /* ============================================================================== */
    buildNotePacket(seq, freq, duration)
    {
        const frame = new Uint8Array(10);
        frame[0] = 0xFA;
        frame[1] = 0x02; // PUSH_NOTE
        frame[2] = seq & 0xFF;
        frame[3] = (seq >> 8) & 0xFF;
        frame[4] = freq & 0xFF;
        frame[5] = (freq >> 8) & 0xFF;
        frame[6] = duration & 0xFF;
        frame[7] = (duration >> 8) & 0xFF;
        frame[8] = FocSerial.calcCrc8(frame, 8);
        frame[9] = 0xFB;
        return frame;
    }

    sendStartSessionCommand(sessionId, gen)
    {
        const frame = new Uint8Array(10);
        frame[0] = 0xFA;
        frame[1] = 0x01; // START_PLAY
        frame[2] = sessionId & 0xFF;
        frame[3] = (sessionId >> 8) & 0xFF;
        frame[4] = 0; frame[5] = 0; frame[6] = 0; frame[7] = 0;
        frame[8] = FocSerial.calcCrc8(frame, 8);
        frame[9] = 0xFB;
        return this.sendFrameWithAck(frame, 0x01, 0, 500, gen);
    }

    sendVolumeCommand(volMv, gen)
    {
        const frame = new Uint8Array(10);
        frame[0] = 0xFA;
        frame[1] = 0x03; // SET_VOLUME
        frame[2] = volMv & 0xFF;
        frame[3] = (volMv >> 8) & 0xFF;
        frame[4] = 0; frame[5] = 0; frame[6] = 0; frame[7] = 0;
        frame[8] = FocSerial.calcCrc8(frame, 8);
        frame[9] = 0xFB;
        return this.serial.sendAudioFrame(frame);
    }

    sendEndStreamCommand(gen)
    {
        const frame = new Uint8Array(10);
        frame[0] = 0xFA;
        frame[1] = 0x05; // END_STREAM
        frame[2] = 0; frame[3] = 0; frame[4] = 0; frame[5] = 0; frame[6] = 0; frame[7] = 0;
        frame[8] = FocSerial.calcCrc8(frame, 8);
        frame[9] = 0xFB;
        return this.sendFrameWithAck(frame, 0x05, 0, 500, gen);
    }

    sendStopCommand()
    {
        const frame = new Uint8Array(10);
        frame[0] = 0xFA;
        frame[1] = 0x04; // STOP_PLAY
        frame[2] = 0; frame[3] = 0; frame[4] = 0; frame[5] = 0; frame[6] = 0; frame[7] = 0;
        frame[8] = FocSerial.calcCrc8(frame, 8);
        frame[9] = 0xFB;
        return this.serial.sendAudioFrame(frame);
    }
}

window.AudioStudio = AudioStudio;
