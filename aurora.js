/**
 * Embedded Hardware Studio · Unified Monochromatic Ray-Tracing & 3D Micro-Physics Suite
 * 1. 单色自然日光光追引擎 (Monochromatic Sunlight Ray-Tracing Engine - 30s 太阳天光轨道)
 * 2. 主入口卡片 4.8° 饱满机械阻尼 3D 物理倾斜 (Main Hub Bold Tilt)
 * 3. 子界面面板 1.8° 精密工控微空间阻尼微浮 (Sub-interface Micro-Physics with Input Guard)
 * 4. 全局控件机械弹性按压与等宽排版 (Tactile Button Springs & Tabular Numbers)
 * 5. 高精度 UTC+8 工程时钟 (Precision Telemetry Clock)
 */

(function () {
    'use strict';

    // =========================================================================
    // 1. 顶栏精密工程时钟
    // =========================================================================
    function initSystemClock() {
        const clockEl = document.getElementById('systemClock');
        if (!clockEl) return;

        function update() {
            const now = new Date();
            const h = String(now.getHours()).padStart(2, '0');
            const m = String(now.getMinutes()).padStart(2, '0');
            const s = String(now.getSeconds()).padStart(2, '0');
            clockEl.textContent = `${h}:${m}:${s} UTC+8`;
        }

        update();
        setInterval(update, 1000);
    }
    initSystemClock();

    // =========================================================================
    // 2. 注入全局子界面触觉弹性样式与工控排版 (Tactile Button Springs & Micro-Physics)
    // =========================================================================
    function injectSubpageGlobalStyles() {
        if (document.getElementById('studio-physics-style')) return;
        const style = document.createElement('style');
        style.id = 'studio-physics-style';
        style.textContent = `
            /* 子界面所有工作舱 GPU 合成加速与光追平滑阻尼 */
            .card, .panel, .sidebar-left, .sidebar-right, .preview-area, .plot-stage, .control-card, .header-panel, .chart-card, .attitude-card, .lcd-hardware-frame {
                will-change: transform;
                transform: translateZ(0);
                transition: border-color 0.25s ease, background 0.25s ease;
            }

            /* 按键与交互控件机械弹性微下陷 (0.975x Elastic Press) */
            button:active:not(:disabled),
            .btn-primary:active:not(:disabled),
            .btn-secondary:active:not(:disabled),
            .btn-action:active:not(:disabled),
            .btn-ota-trigger:active:not(:disabled),
            .btn-mock-sim:active:not(:disabled),
            .tab-btn:active,
            .icon-btn:active,
            .btn-stage-tab:active,
            .btn-tool:active {
                transform: scale(0.975) translateY(0.5px) !important;
                transition: transform 0.06s ease-out !important;
            }

            /* 工控遥测数值等宽对齐 (Tabular Numbers) */
            .stat-val, .metric-value, .telemetry-val, .spec-value, .baud-label, .chip-badge, .badge-val, #statRate, #statFrames, #statChannels, .zoom-val, .baud-chip {
                font-feature-settings: "tnum" 1, "cv02" 1;
                font-variant-numeric: tabular-nums;
            }
        `;
        document.head.appendChild(style);
    }
    injectSubpageGlobalStyles();

    // =========================================================================
    // 3. 单色自然日光光追引擎 (Monochromatic Sunlight Ray-Tracing Engine)
    // =========================================================================
    const canvas = document.getElementById('auroraCanvas');
    let ctx = null;
    let width = window.innerWidth;
    let height = window.innerHeight;

    if (canvas) {
        ctx = canvas.getContext('2d');
        canvas.width = width;
        canvas.height = height;

        window.addEventListener('resize', () => {
            width = canvas.width = window.innerWidth;
            height = canvas.height = window.innerHeight;
        }, { passive: true });
    }

    let time = 0;
    const isMainHub = document.querySelectorAll('.workbench-card').length > 0;
    const targetCards = Array.from(
        isMainHub 
            ? document.querySelectorAll('.workbench-card') 
            : document.querySelectorAll('.card, .control-card')
    );

    function renderRayTracedSunlight() {
        if (ctx) {
            ctx.clearRect(0, 0, width, height);
            time += 1;

            // 太阳光光源物理轨道坐标 (30s 周期)
            const lightX = width * (0.50 + 0.38 * Math.cos(time * 0.0018));
            const lightY = height * (0.16 + 0.10 * Math.sin(time * 0.0024));
            const maxDim = Math.max(width, height);
            const sunRadius = maxDim * 0.95;

            // 绘制纯白自然漫射光场
            ctx.save();
            ctx.translate(lightX, lightY);
            const sunGrad = ctx.createRadialGradient(0, 0, 0, 0, 0, sunRadius);
            sunGrad.addColorStop(0, 'rgba(255, 255, 255, 0.40)');
            sunGrad.addColorStop(0.40, 'rgba(241, 245, 249, 0.16)');
            sunGrad.addColorStop(0.75, 'rgba(226, 232, 240, 0.04)');
            sunGrad.addColorStop(1, 'transparent');

            ctx.fillStyle = sunGrad;
            ctx.beginPath();
            ctx.arc(0, 0, sunRadius, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();

            // 实时光追投影与高光计算
            if (isMainHub) {
                for (let i = 0; i < targetCards.length; i++) {
                    const card = targetCards[i];
                    const rect = card.getBoundingClientRect();
                    if (rect.width === 0) continue;

                    const cardCenterX = rect.left + rect.width / 2;
                    const cardCenterY = rect.top + rect.height / 2;

                    const dx = cardCenterX - lightX;
                    const dy = cardCenterY - lightY;
                    const dist = Math.sqrt(dx * dx + dy * dy);

                    const s1X = (dx * 0.014).toFixed(2);
                    const s1Y = (dy * 0.014 + 3.5).toFixed(2);
                    const s1Blur = 8;

                    const s2X = (dx * 0.038).toFixed(2);
                    const s2Y = (dy * 0.038 + 18).toFixed(2);
                    const s2Blur = (30 + (dist / maxDim) * 16).toFixed(1);

                    const angleRad = Math.atan2(-dy, -dx);
                    const hlX = (Math.cos(angleRad) * 1.5).toFixed(2);
                    const hlY = (Math.sin(angleRad) * 1.5).toFixed(2);

                    const isHovered = card.dataset.isHovered === 'true';
                    const tiltX = parseFloat(card.dataset.tiltX || 0);
                    const tiltY = parseFloat(card.dataset.tiltY || 0);

                    if (!isHovered) {
                        card.style.boxShadow = `
                            ${s1X}px ${s1Y}px ${s1Blur}px 0 rgba(15, 23, 42, 0.035),
                            ${s2X}px ${s2Y}px ${s2Blur}px -10px rgba(15, 23, 42, 0.055),
                            inset ${hlX}px ${hlY}px 1px 0 #FFFFFF,
                            inset 0 -1px 1px 0 rgba(255, 255, 255, 0.40)
                        `;
                    } else {
                        const hoverS2X = (dx * 0.050 + tiltY * 1.8).toFixed(2);
                        const hoverS2Y = (dy * 0.050 + 28 - tiltX * 1.8).toFixed(2);
                        card.style.boxShadow = `
                            ${s1X}px ${s1Y}px 12px 0 rgba(15, 23, 42, 0.04),
                            ${hoverS2X}px ${hoverS2Y}px 56px -14px rgba(15, 23, 42, 0.085),
                            inset ${hlX}px ${hlY}px 1.5px 0 #FFFFFF,
                            inset 0 -1.5px 1.5px 0 rgba(255, 255, 255, 0.60)
                        `;
                    }
                }
            }
        }

        requestAnimationFrame(renderRayTracedSunlight);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            requestAnimationFrame(renderRayTracedSunlight);
            initPhysicsCards();
        });
    } else {
        requestAnimationFrame(renderRayTracedSunlight);
        initPhysicsCards();
    }

    // =========================================================================
    // 4. 智能自适应 3D 物理立体倾斜引擎 (支持主门户 4.8° 与子界面 1.8° 精准微阻尼)
    // =========================================================================
    function initPhysicsCards() {
        const SUB_PANEL_SELECTOR = '.card, .panel, .sidebar-left, .sidebar-right, .preview-area, .plot-stage, .control-card, .header-panel, .chart-card, .attitude-card, .lcd-hardware-frame';
        const elements = document.querySelectorAll(
            isMainHub ? '.workbench-card' : SUB_PANEL_SELECTOR
        );

        const maxTiltAngle = isMainHub ? 4.8 : 1.8;   // 子界面使用 1.8° 克制微倾斜
        const maxLiftY = isMainHub ? -5.0 : -2.5;     // 子界面微抬 2.5px
        const maxLiftZ = isMainHub ? 14.0 : 6.0;      // 子界面 6px 空间视差

        elements.forEach((card) => {
            let bounds;
            let rafId = null;
            let currentRotateX = 0;
            let currentRotateY = 0;
            let currentY = 0;
            let currentZ = 0;
            let targetRotateX = 0;
            let targetRotateY = 0;
            let targetY = 0;
            let targetZ = 0;
            let isHovered = false;

            function updateTilt() {
                // 0.09 连续物理弹簧阻尼插值
                currentRotateX += (targetRotateX - currentRotateX) * 0.09;
                currentRotateY += (targetRotateY - currentRotateY) * 0.09;
                currentY += (targetY - currentY) * 0.09;
                currentZ += (targetZ - currentZ) * 0.09;

                card.dataset.tiltX = currentRotateX.toFixed(2);
                card.dataset.tiltY = currentRotateY.toFixed(2);

                card.style.transform = `perspective(1200px) rotateX(${currentRotateX.toFixed(2)}deg) rotateY(${currentRotateY.toFixed(2)}deg) translateY(${currentY.toFixed(2)}px) translateZ(${currentZ.toFixed(2)}px)`;

                const delta = Math.abs(targetRotateX - currentRotateX) +
                              Math.abs(targetRotateY - currentRotateY) +
                              Math.abs(targetY - currentY) +
                              Math.abs(targetZ - currentZ);

                if (delta > 0.005 || isHovered) {
                    rafId = requestAnimationFrame(updateTilt);
                } else {
                    rafId = null;
                    if (!isHovered) {
                        card.style.transform = '';
                    }
                }
            }

            function handleMouseMove(e) {
                // 工控安全防护：如果鼠标正在与输入框、按钮、滑块、Canvas 交互，则跳过卡片微倾斜
                if (e.target.closest('input, textarea, select, button, canvas, .chart-canvas, .no-tilt, [draggable="true"]')) {
                    targetRotateX = 0;
                    targetRotateY = 0;
                    return;
                }

                if (!bounds) bounds = card.getBoundingClientRect();
                const mouseX = e.clientX;
                const mouseY = e.clientY;
                const leftX = mouseX - bounds.left;
                const topY = mouseY - bounds.top;

                const centerX = leftX - bounds.width / 2;
                const centerY = topY - bounds.height / 2;
                targetRotateX = -(centerY / (bounds.height / 2)) * maxTiltAngle;
                targetRotateY = (centerX / (bounds.width / 2)) * maxTiltAngle;

                if (!rafId) {
                    rafId = requestAnimationFrame(updateTilt);
                }
            }

            card.addEventListener('mouseenter', () => {
                isHovered = true;
                card.dataset.isHovered = 'true';
                bounds = card.getBoundingClientRect();
                targetY = maxLiftY;
                targetZ = maxLiftZ;
                card.addEventListener('mousemove', handleMouseMove, { passive: true });
                if (!rafId) {
                    rafId = requestAnimationFrame(updateTilt);
                }
            });

            card.addEventListener('mouseleave', () => {
                isHovered = false;
                card.dataset.isHovered = 'false';
                card.removeEventListener('mousemove', handleMouseMove);
                bounds = null;
                targetRotateX = 0;
                targetRotateY = 0;
                targetY = 0;
                targetZ = 0;
                if (!rafId) {
                    rafId = requestAnimationFrame(updateTilt);
                }
            });
        });
    }
})();








