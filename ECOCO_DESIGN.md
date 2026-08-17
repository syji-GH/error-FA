# ECOCO Brand Design System

> 這份文件是 ecoco 品牌 UI 的設計規範，專為 AI coding agent 設計。
> 使用方式：將此檔案放在專案根目錄，告訴 AI agent「請依照 ECOCO_DESIGN.md 建構頁面」。
>
> **This file is the single source of truth for all ecoco UI work.**
> Any other design system (Notion, Linear, Apple, etc.) must NOT override these rules.

---

## 1. Visual Theme & Atmosphere

ecoco 的視覺語言是「**現代環保科技品牌**」— 乾淨、大膽、有力量，帶有一絲工業/editorial 質感。

- **主色調對比**：白底 + 深黑文字，配合橘色作為唯一醒目 CTA
- **氣氛**：專業可信任（內部工具感）但不冷漠；中文排版優先
- **禁止使用**：漸層色背景、繁複裝飾、多種主色競爭
- **Hero 區塊**：黑色底 + 品牌圖像，加深色遮罩保持文字可讀

---

## 2. Color Palette

### Brand Colors（品牌色）
```
--color-ecoco-orange:     #FF5000   → 主要 CTA、強調色、邊框高亮
--color-ecoco-blue:       #060E9F   → 次要 CTA、資訊型 badge、連結
--color-ecoco-yellow:     #FFCE00   → 輔助標記（如 folder icon、highlight）
--color-ecoco-light-blue: #8EB9C9   → 圖表、說明性區塊
--color-ecoco-beige:      #FAE0B8   → 暖色說明區塊背景
--color-ecoco-cyan:       #0076A9   → 深色背景上的連結、輔助操作
```

### Semantic Colors（語意色）
```
Background (page):   #F7F9FC   → 整頁背景
Background (card):   #F0F3F7   → 卡片、hover 狀態、次要背景
Surface (white):     #FFFFFF   → 主要內容面板、modal、sidebar
Hero:                #000000   → Hero 區塊全黑底

Text (primary):      #1A1A1A   → 所有主要內文
Text (secondary):    #4B5563   → 說明文字
Text (muted):        #6B7280   → 標籤、次要標題
Text (placeholder):  #9CA3AF   → Input placeholder

Border (default):    #E5E7EB
Border (inner):      #F0F3F7   → 元件內部分隔線

Status (success):    green-500 (#22C55E)
Status (error/lock): red-600 (#DC2626)  → 受限資源
Status (info):       #060E9F (ecoco-blue)
```

### Color Usage Rules（使用規則）
- `#FF5000` 只用於：主要 CTA 按鈕、search bar 邊框、hover 高亮
- `#060E9F` 只用於：次要行動按鈕、category badge 文字、資訊圖示
- **不要讓橘色與藍色在同一個元件上競爭注意力**
- 頁面背景永遠是 `#F7F9FC`，不是純白

---

## 3. Typography

### Font Family
```
Primary: "Noto Sans TC", "system-ui", sans-serif
```
繁體中文優先，所有介面文字均使用 Noto Sans TC。

### Weight Hierarchy（字重階層）
```
font-black (900) → 主標題、英雄標題、按鈕 CTA、卡片標題
font-bold  (700) → 小標、標籤、導覽項目、說明標題
font-medium(500) → 內文說明
font-mono        → AI prompt 程式碼片段（等寬字型）
```

### Size & Tracking（尺寸與字距）
```
Hero h1:         text-5xl / text-6xl + font-black + tracking-tight
Section h2:      text-xl + font-black + tracking-tight
Panel title:     text-lg + font-black + tracking-tight
Label (micro):   text-[10px] + font-bold + tracking-widest + uppercase
Body text:       text-sm + font-medium + leading-relaxed
Search input:    text-lg + font-bold
Button CTA:      text-[15px] + font-bold
Badge text:      text-[10px] / text-[13px] + font-bold + uppercase
```

### Chinese Typography Rules
- 標題不加標點符號結尾
- 英文/數字混排時，英文用 uppercase + tracking-wide 增強辨識
- 中英混排標題：中文在前，英文縮寫用括號 `(ALL)` 標注

---

## 4. Component Styling

### Buttons（按鈕）

**Primary CTA（橘色）**
```
bg-[#FF5000] text-white font-bold rounded-full
px-5 py-2 (small) | py-3.5 px-4 (full-width)
shadow-[0_4px_16px_rgba(255,80,0,0.3)]
hover:bg-[#E64800] hover:scale-105 transition-all
```

**Secondary CTA（藍色）**
```
bg-[#060E9F] text-white font-bold rounded-full
hover:bg-[#FF5000] → hover 時切換為橘色
shadow-lg transition-all hover:-translate-y-0.5
```

**Ghost / Utility Button**
```
text-[#6B7280] hover:text-[#1A1A1A]
hover:bg-[#F0F3F7] rounded-full transition-colors
```

**Disabled / Done State**
```
bg-green-500 cursor-default text-white rounded-full
```

**Danger（受限資源）**
```
bg-red-600 hover:bg-red-700 text-white rounded-full
```

### Input / Search Bar
```
外框: border-[4px] border-[#FF5000]
形狀: rounded-[40px] (collapsed) → rounded-[24px] (expanded)
背景: bg-white shadow-[0_20px_60px_-15px_rgba(0,0,0,0.15)]
內距: px-6 py-3 md:py-4
input: text-lg font-bold bg-transparent outline-none
placeholder: text-[#9CA3AF]
```

### Cards（素材卡片）
```
背景: bg-white
圓角: rounded-2xl 或 rounded-xl
邊框: border border-[#E5E7EB]
陰影: shadow-sm → hover:shadow-md
Hover: scale-105 transition-all duration-200
```

### Badges / Tags
```
Category badge:  bg-[#F0F3F7] text-[#060E9F] rounded-lg px-2.5 py-1 text-[10px] font-bold uppercase tracking-widest
Format badge:    bg-[#F0F3F7] text-[#1A1A1A] rounded px-2 py-0.5 text-xs font-black uppercase
Hashtag:         bg-[#F7F9FC] border border-[#E5E7EB] text-[#6B7280] rounded text-[10px] font-bold
Campaign badge:  bg-orange-50 text-[#FF5000] border border-orange-200 rounded-lg
Usage scenario:  bg-blue-50 text-[#060E9F] border border-blue-100 rounded-lg
Restricted:      bg-red-50 text-red-600 rounded-lg
```

### Sidebar / Panel
```
位置: fixed right-0 inset-y-0
寬度: w-full md:w-[420px]
背景: bg-white
邊框: border-l border-[#E5E7EB]
陰影: shadow-[0_10px_40px_-10px_rgba(0,0,0,0.12)]
遮罩: bg-[#1A1A1A]/20 backdrop-blur-sm (overlay)
動畫: transform transition-transform duration-300 ease-in-out
```

### Info Block / Code Preview
```
外框: bg-[#F7F9FC] border border-[#E5E7EB] rounded-2xl p-4
程式碼區: bg-white border border-[#E5E7EB] rounded-xl p-3
文字: text-xs text-[#4B5563] font-mono leading-relaxed
```

### Header / Navbar
```
bg-white shadow-sm border-b border-[#E5E7EB]
sticky top-0 z-50
高度: h-16
Logo + 標題分隔線: border-l-2 border-[#E5E7EB] pl-3 ml-3
標題: text-xl font-black tracking-tighter uppercase
```

---

## 5. Layout & Spacing

### Container
```
max-w-7xl mx-auto px-4 sm:px-6 lg:px-8
```

### Grid（卡片網格）
```
Responsive: grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4
Gap: gap-4 或 gap-6
```

### Section Spacing
```
Hero:    pt-20 pb-28 (較大留白)
Section: py-10 md:py-16
內部卡片: p-5 或 p-6
行距:    space-y-5 (panel 內容)
```

### Z-Index Layers
```
Sticky header:   z-50
Search dropdown: z-40
Overlay mask:    z-40
Sidebar panel:   z-50
Floating button: z-30
```

---

## 6. Depth & Shadow System

```
微陰影（卡片）:   shadow-sm
中陰影（hover）:  shadow-md
Panel 陰影:      shadow-[0_10px_40px_-10px_rgba(0,0,0,0.12)]
搜尋框陰影:      shadow-[0_20px_60px_-15px_rgba(0,0,0,0.15)]
橘色發光:        shadow-[0_4px_16px_rgba(255,80,0,0.3)]
底部 bar 陰影:   shadow-[0_-4px_16px_rgba(0,0,0,0.04)]
```

Hero 遮罩層級：
```
<div style="background-image: url(...)">  → bg-black base
  <div class="absolute inset-0 bg-black/35 z-0" />  → 35% 遮罩
  <div class="relative z-10">內容</div>
```

---

## 7. Design Guardrails & Anti-Patterns

### 絕對禁止（Anti-Patterns）
- **不要用漸層色** — 背景、按鈕一律純色，不用 bg-gradient-*
- **不要用圓角 rounded-full 在矩形容器** — 大容器用 rounded-xl 或 rounded-2xl
- **不要讓品牌色互相競爭** — 一個區塊只用一種主色作為強調
- **不要用 Tailwind 預設藍色 (blue-500/600)** — 永遠用 `#060E9F` (ecoco-blue)
- **不要用 Tailwind 預設橘色 (orange-500)** — 永遠用 `#FF5000` (ecoco-orange)
- **不要在 Hero 以外使用全黑背景**
- **不要省略繁體中文字型** — font-family 必須包含 "Noto Sans TC"
- **不要用 Arial / Helvetica** 作為中文字型

### 設計守則
- 按鈕 CTA 一律 `rounded-full`；容器、卡片、badge 用 `rounded-xl` 或 `rounded-lg`
- 只有一個「最重要的行動」會用橘色，其他次要行動用藍色或 ghost 樣式
- 微標籤文字（10px）加 `uppercase + tracking-widest` 增強可讀性
- Hover 狀態必須有回饋：scale、color change、或 shadow change，至少一種
- 圖示使用 Lucide React，大小通常 `w-4 h-4` 到 `w-5 h-5`

---

## 8. Responsive Behavior

### Breakpoints（沿用 Tailwind 預設）
```
sm:  640px  → 卡片 2 欄、sidebar 全寬 → 固定寬度
md:  768px  → sidebar 固定 420px、Hero 字型放大
lg:  1024px → 卡片 3 欄、導覽完整顯示
xl:  1280px → 卡片 4 欄
```

### Mobile Considerations
- 搜尋框在 mobile 佔滿寬度，border radius 動態切換
- Sidebar 在 mobile 全螢幕 (`w-full`)，md 以上才固定 420px
- 格式篩選按鈕可橫向滑動 (`overflow-x-auto scrollbar-hide`)
- Hero 文字在 mobile 縮小 (`text-5xl`)，desktop 放大 (`md:text-6xl`)

---

## 9. Agent Prompt Guide

### 快速啟動 Prompt
```
請依照 ECOCO_DESIGN.md 建構 UI。
背景色 #F7F9FC，主色 #FF5000（橘），次色 #060E9F（藍），字型 Noto Sans TC。
標題 font-black，按鈕 rounded-full，卡片 rounded-2xl bg-white border border-[#E5E7EB]。
```

### 建立新頁面
```
使用 ECOCO_DESIGN.md 的設計規範建立 [頁面描述]。
- 頁面背景: bg-[#F7F9FC]
- Header: sticky, bg-white, border-b border-[#E5E7EB], h-16
- 主要 CTA 按鈕: bg-[#FF5000] text-white rounded-full font-bold
- 次要 CTA 按鈕: bg-[#060E9F] text-white rounded-full font-bold
- 所有文字: font-family "Noto Sans TC"
- 不要使用任何漸層色
```

### 建立卡片元件
```
依照 ECOCO_DESIGN.md 建立卡片元件：
bg-white rounded-2xl border border-[#E5E7EB] shadow-sm
hover:shadow-md hover:scale-105 transition-all duration-200
標題: font-black text-[#1A1A1A]
說明: text-sm text-[#4B5563] font-medium
```

### 建立表單 / Modal
```
依照 ECOCO_DESIGN.md 建立表單：
背景遮罩: bg-[#1A1A1A]/20 backdrop-blur-sm
卡片: bg-white rounded-2xl shadow-[0_10px_40px_-10px_rgba(0,0,0,0.12)]
Submit 按鈕: bg-[#FF5000] text-white rounded-full font-bold shadow-[0_4px_16px_rgba(255,80,0,0.3)]
Cancel 按鈕: ghost style, text-[#6B7280] hover:text-[#1A1A1A]
```

### 品牌色參照速查
```
橘色 #FF5000 → CTA, 強調, hover highlight
藍色 #060E9F → 次要 CTA, info badge, link
黃色 #FFCE00 → 輔助標記
頁面底色 #F7F9FC
卡片白 #FFFFFF
邊框 #E5E7EB
主文 #1A1A1A
```
