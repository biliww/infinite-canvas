"use client";

import { type ReactNode } from "react";
import { Settings2 } from "lucide-react";
import { Button, Popover } from "antd";

import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import type { AiConfig } from "@/stores/use-config-store";
import { CanvasImageSettingsTheme } from "./canvas-image-settings-popover";

const resolutionOptions = [
    { value: "720", label: "720p" },
    { value: "480", label: "480p" },
];
const sizeOptions = [
    { value: "1280x720", label: "横屏", width: 1280, height: 720 },
    { value: "720x1280", label: "竖屏", width: 720, height: 1280 },
    { value: "1024x1024", label: "方形", width: 1024, height: 1024 },
    { value: "1792x1024", label: "宽屏", width: 1792, height: 1024 },
    { value: "1024x1792", label: "长图", width: 1024, height: 1792 },
];
const secondOptions = [6, 10, 12, 16, 20];

type CanvasVideoSettingsPopoverProps = {
    config: AiConfig;
    onConfigChange: (key: keyof AiConfig, value: string) => void;
    buttonClassName?: string;
    placement?: "topLeft" | "top" | "topRight" | "bottomLeft" | "bottom" | "bottomRight";
};

export function CanvasVideoSettingsPopover({ config, onConfigChange, buttonClassName, placement = "topLeft" }: CanvasVideoSettingsPopoverProps) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const seconds = config.videoSeconds || "6";
    const size = normalizeVideoSize(config.size);
    const dimensions = readSizeDimensions(size);
    const resolution = normalizeVideoResolution(config.vquality);
    const updateDimension = (key: "width" | "height", value: number | null) => {
        const next = Math.max(1, Math.floor(value || dimensions[key] || 720));
        onConfigChange("size", `${key === "width" ? next : dimensions.width}x${key === "height" ? next : dimensions.height}`);
    };

    return (
        <Popover
            trigger="click"
            placement={placement}
            arrow={false}
            overlayClassName="canvas-image-settings-popover"
            color={theme.toolbar.panel}
            zIndex={1200}
            getPopupContainer={() => document.body}
            content={
                <CanvasImageSettingsTheme theme={theme}>
                    <div className="w-[360px] space-y-5 rounded-3xl px-1 py-0.5" style={{ color: theme.node.text }} onMouseDown={(event) => event.stopPropagation()}>
                        <div className="text-xl font-semibold">视频设置</div>
                        <SettingGroup title="清晰度" color={theme.node.muted}>
                            <div className="grid grid-cols-2 gap-3">
                                {resolutionOptions.map((item) => (
                                    <OptionPill key={item.value} selected={resolution === item.value} theme={theme} onClick={() => onConfigChange("vquality", item.value)}>
                                        {item.label}
                                    </OptionPill>
                                ))}
                            </div>
                            <ResolutionInput value={resolution} theme={theme} onChange={(value) => onConfigChange("vquality", value)} />
                        </SettingGroup>
                        <SettingGroup title="尺寸" color={theme.node.muted}>
                            <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3">
                                <DimensionInput prefix="W" value={dimensions.width} theme={theme} onChange={(value) => updateDimension("width", value)} />
                                <span className="text-lg opacity-45">↔</span>
                                <DimensionInput prefix="H" value={dimensions.height} theme={theme} onChange={(value) => updateDimension("height", value)} />
                            </div>
                            <div className="grid grid-cols-5 gap-2">
                                {sizeOptions.map((item) => (
                                    <button
                                        key={item.value}
                                        type="button"
                                        className="flex h-[82px] cursor-pointer flex-col items-center justify-center gap-2 rounded-2xl border bg-transparent text-xs transition hover:opacity-80"
                                        style={{ borderColor: size === item.value ? theme.node.text : theme.node.stroke, color: theme.node.text }}
                                        onMouseDown={(event) => event.stopPropagation()}
                                        onClick={() => onConfigChange("size", item.value)}
                                    >
                                        <SizePreview width={item.width} height={item.height} color={theme.node.text} />
                                        <span>{item.label}</span>
                                    </button>
                                ))}
                            </div>
                        </SettingGroup>
                        <SettingGroup title="秒数" color={theme.node.muted}>
                            <div className="grid grid-cols-5 gap-2">
                                {secondOptions.map((value) => (
                                    <OptionPill key={value} selected={seconds === String(value)} theme={theme} onClick={() => onConfigChange("videoSeconds", String(value))}>
                                        {value}s
                                    </OptionPill>
                                ))}
                                <input
                                    type="number"
                                    min={6}
                                    max={20}
                                    className="col-span-2 h-10 rounded-full border bg-transparent px-3 text-center text-sm outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                                    style={{ borderColor: theme.node.stroke, color: theme.node.text, WebkitTextFillColor: theme.node.text }}
                                    value={seconds}
                                    onChange={(event) => onConfigChange("videoSeconds", event.target.value)}
                                    onMouseDown={(event) => event.stopPropagation()}
                                />
                            </div>
                        </SettingGroup>
                    </div>
                </CanvasImageSettingsTheme>
            }
        >
            <Button size="small" type="text" className={buttonClassName || "!h-8 !max-w-[170px] !justify-start !rounded-full !px-2.5"} style={{ background: theme.node.fill, color: theme.node.text }} icon={<Settings2 className="size-3.5" />}>
                <span className="truncate">
                    {resolution}p · {sizeLabel(size)} · {seconds}s
                </span>
            </Button>
        </Popover>
    );
}

function OptionPill({ selected, theme, onClick, children }: { selected: boolean; theme: (typeof canvasThemes)[keyof typeof canvasThemes]; onClick: () => void; children: ReactNode }) {
    return (
        <button type="button" className="h-10 cursor-pointer rounded-full border px-2 text-sm transition hover:opacity-80" style={{ background: "transparent", borderColor: selected ? theme.node.text : theme.node.stroke, color: theme.node.text }} onMouseDown={(event) => event.stopPropagation()} onClick={onClick}>
            {children}
        </button>
    );
}

function SettingGroup({ title, color, children }: { title: string; color: string; children: ReactNode }) {
    return (
        <div className="space-y-3">
            <div className="text-xs font-medium" style={{ color }}>
                {title}
            </div>
            {children}
        </div>
    );
}

function ResolutionInput({ value, theme, onChange }: { value: string; theme: (typeof canvasThemes)[keyof typeof canvasThemes]; onChange: (value: string) => void }) {
    return (
        <label className="flex h-10 overflow-hidden rounded-xl border text-sm" style={{ borderColor: theme.node.stroke, color: theme.node.text }}>
            <input
                type="number"
                min={1}
                className="min-w-0 flex-1 bg-transparent px-3 outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                value={value}
                onChange={(event) => onChange(event.target.value)}
                onMouseDown={(event) => event.stopPropagation()}
            />
            <span className="grid w-10 place-items-center" style={{ color: theme.node.muted }}>
                p
            </span>
        </label>
    );
}

function DimensionInput({ prefix, value, theme, onChange }: { prefix: string; value: number; theme: (typeof canvasThemes)[keyof typeof canvasThemes]; onChange: (value: number | null) => void }) {
    return (
        <label className="flex h-10 overflow-hidden rounded-xl text-sm" style={{ background: theme.node.fill, color: theme.node.text }}>
            <span className="grid w-10 place-items-center" style={{ color: theme.node.muted }}>
                {prefix}
            </span>
            <input
                type="number"
                min={1}
                className="min-w-0 flex-1 bg-transparent px-2 outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                value={value || ""}
                onChange={(event) => onChange(Number(event.target.value) || null)}
                onMouseDown={(event) => event.stopPropagation()}
            />
        </label>
    );
}

function SizePreview({ width, height, color }: { width: number; height: number; color: string }) {
    const longSide = Math.max(width, height);
    const previewWidth = Math.max(12, Math.round((width / longSide) * 34));
    const previewHeight = Math.max(12, Math.round((height / longSide) * 34));
    return <span className="rounded-[4px] border" style={{ width: previewWidth, height: previewHeight, borderColor: color }} />;
}

function normalizeVideoSize(value: string) {
    if (/^\d+x\d+$/.test(value || "")) return value;
    return ["9:16", "2:3", "3:4"].includes(value) ? "720x1280" : "1280x720";
}

function normalizeVideoResolution(value: string) {
    if (value === "480p" || value === "low") return "480";
    if (value === "720p" || value === "auto" || value === "high" || value === "medium") return "720";
    return value.replace(/p$/i, "") || "720";
}

function readSizeDimensions(size: string) {
    const match = size.match(/^(\d+)x(\d+)$/);
    return { width: Number(match?.[1]) || 1280, height: Number(match?.[2]) || 720 };
}

function sizeLabel(value: string) {
    return ({ "720x1280": "竖屏", "1280x720": "横屏", "1024x1024": "方形", "1792x1024": "宽屏", "1024x1792": "长图" } as Record<string, string>)[value] || value;
}
