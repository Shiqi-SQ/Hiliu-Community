# FontAwesome 7.1.0 Pro

## 文件说明

### 核心文件
- **all.css** (177KB, 31 @font-face) - **推荐使用**：包含所有样式族的完整合集
- **fontawesome.css** (135KB) - 仅包含核心样式和类名定义，不含字体声明

### 单独样式文件
按需加载单个样式族（需配合 fontawesome.css 使用）：

#### Jelly 系列 (圆润果冻风格)
- `jelly-fill-regular.css` - 填充样式
- `jelly-regular.css` - 常规样式
- `jelly-duo-regular.css` - 双色样式

#### Classic 系列
- `solid.css` - 填充样式
- `regular.css` - 常规样式
- `light.css` - 轻量样式
- `thin.css` - 纤细样式

#### Duotone 系列
- `duotone.css` - 双色样式
- `duotone-light.css`, `duotone-regular.css`, `duotone-thin.css`

#### Sharp 系列
- `sharp-solid.css`, `sharp-regular.css`, `sharp-light.css`, `sharp-thin.css`
- `sharp-duotone-light.css`, `sharp-duotone-regular.css`, `sharp-duotone-solid.css`, `sharp-duotone-thin.css`

#### 其他样式
- `brands.css` - 品牌图标
- `chisel-regular.css` - 雕刻风格
- `etch-solid.css` - 蚀刻风格
- `notdog-solid.css`, `notdog-duo-solid.css` - NotDog 风格
- `slab-regular.css`, `slab-press-regular.css` - 粗衬线风格
- `thumbprint-light.css` - 指纹风格
- `utility-semibold.css`, `utility-duo-semibold.css`, `utility-fill-semibold.css` - 实用风格
- `whiteboard-semibold.css` - 白板风格

## 使用方法

### 方法 1：引用完整合集（推荐）
```html
<link rel="stylesheet" href="/css/font-awesome/v7.1.0/all.css">
<i class="fa-jelly-fill fa-regular fa-paw"></i>
```

### 方法 2：按需加载
```html
<link rel="stylesheet" href="/css/font-awesome/v7.1.0/fontawesome.css">
<link rel="stylesheet" href="/css/font-awesome/v7.1.0/jelly-fill-regular.css">
<i class="fa-jelly-fill fa-regular fa-paw"></i>
```

## 路径配置
所有 CSS 文件已配置为相对路径引用：
- Webfonts 目录：`webfonts/`
- 完整路径示例：`/css/font-awesome/v7.1.0/webfonts/fa-jelly-fill-regular-400.woff2`

## 版本信息
- **版本**: FontAwesome Pro 7.1.0
- **字体文件数**: 31 个 woff2 文件
- **样式族数**: 14+ 种风格
- **图标总数**: 30,000+ 个专业图标
