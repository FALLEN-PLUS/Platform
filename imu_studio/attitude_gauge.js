"use strict";

/**
 * IMU Motion Studio · 航空姿态水平仪仪表盘 (Attitude Indicator Gauge)
 * 仿 VOFA+ 经典物理姿态表盘
 */
class AttitudeGauge
{
    constructor(canvas)
    {
        this.canvas = canvas;
        this.ctx = canvas.getContext("2d");
        this.roll = 0;   // deg
        this.pitch = 0;  // deg
        this.yaw = 0;    // deg

        this.resize();
        this.draw();
    }

    setPose(rollDeg, pitchDeg, yawDeg)
    {
        this.roll = rollDeg;
        this.pitch = pitchDeg;
        this.yaw = yawDeg;
        this.draw();
    }

    resize()
    {
        const rect = this.canvas.getBoundingClientRect();
        const ratio = Math.max(1, window.devicePixelRatio || 1);
        const size = Math.max(1, Math.round(Math.min(rect.width, rect.height) * ratio));
        if (this.canvas.width !== size || this.canvas.height !== size)
        {
            this.canvas.width = size;
            this.canvas.height = size;
        }
    }

    draw()
    {
        const ctx = this.ctx;
        const width = this.canvas.width;
        const height = this.canvas.height;
        if (width === 0 || height === 0) { return; }

        ctx.clearRect(0, 0, width, height);

        const cx = width / 2;
        const cy = height / 2;
        const radius = (Math.min(width, height) / 2) - 6;

        ctx.save();
        // 1. 圆形裁切视口
        ctx.beginPath();
        ctx.arc(cx, cy, radius, 0, Math.PI * 2);
        ctx.clip();

        // 2. 绘制姿态天空(蓝)与大地(棕)背景 (随 Roll 和 Pitch 倾斜平移)
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate((-this.roll * Math.PI) / 180);

        // Pitch 垂直平移像素 (每度 1.8 像素)
        const pitchOffset = Math.max(-radius * 0.85, Math.min(radius * 0.85, this.pitch * 1.6));
        ctx.translate(0, pitchOffset);

        // 天空 (清新蔚蓝)
        ctx.fillStyle = "#38BDF8";
        ctx.fillRect(-radius * 2, -radius * 2, radius * 4, radius * 2);

        // 大地 (沉稳大地棕/暗金)
        ctx.fillStyle = "#B45309";
        ctx.fillRect(-radius * 2, 0, radius * 4, radius * 2);

        // 地平天地分界线 (纯白)
        ctx.strokeStyle = "#FFFFFF";
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.moveTo(-radius * 2, 0);
        ctx.lineTo(radius * 2, 0);
        ctx.stroke();

        // 俯仰刻度梯线 (+-10°, +-20°, +-30°)
        ctx.strokeStyle = "rgba(255, 255, 255, 0.85)";
        ctx.fillStyle = "#FFFFFF";
        ctx.font = `600 ${Math.max(9, Math.round(radius * 0.11))}px "JetBrains Mono", monospace`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";

        for (let deg = -60; deg <= 60; deg += 10)
        {
            if (deg === 0) { continue; }
            const y = -deg * 1.6;
            const w = deg % 20 === 0 ? radius * 0.45 : radius * 0.25;
            ctx.lineWidth = deg % 20 === 0 ? 2.0 : 1.2;
            ctx.beginPath();
            ctx.moveTo(-w / 2, y);
            ctx.lineTo(w / 2, y);
            ctx.stroke();

            if (deg % 20 === 0)
            {
                ctx.fillText(String(Math.abs(deg)), -w / 2 - 12, y);
                ctx.fillText(String(Math.abs(deg)), w / 2 + 12, y);
            }
        }
        ctx.restore();

        // 3. 固定机体指示基准十字准星 (黄色/橙色)
        ctx.strokeStyle = "#F59E0B";
        ctx.fillStyle = "#F59E0B";
        ctx.lineWidth = 3.2;

        // 左翼水平线
        ctx.beginPath();
        ctx.moveTo(cx - radius * 0.55, cy);
        ctx.lineTo(cx - radius * 0.18, cy);
        ctx.lineTo(cx - radius * 0.18, cy + 6);
        ctx.stroke();

        // 右翼水平线
        ctx.beginPath();
        ctx.moveTo(cx + radius * 0.55, cy);
        ctx.lineTo(cx + radius * 0.18, cy);
        ctx.lineTo(cx + radius * 0.18, cy + 6);
        ctx.stroke();

        // 中心圆点
        ctx.beginPath();
        ctx.arc(cx, cy, 4, 0, Math.PI * 2);
        ctx.fill();

        ctx.restore(); // 恢复裁切

        // 4. 表盘外金属圈与罗盘刻度
        ctx.save();
        ctx.strokeStyle = "rgba(255, 255, 255, 0.25)";
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(cx, cy, radius, 0, Math.PI * 2);
        ctx.stroke();

        // 顶部滚转倾角指示三角形
        ctx.fillStyle = "#EF4444";
        ctx.beginPath();
        ctx.moveTo(cx, cy - radius + 2);
        ctx.lineTo(cx - 6, cy - radius + 14);
        ctx.lineTo(cx + 6, cy - radius + 14);
        ctx.closePath();
        ctx.fill();

        ctx.restore();
    }
}

if (typeof window !== "undefined")
{
    window.AttitudeGauge = AttitudeGauge;
}
