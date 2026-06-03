# BrowserDebugBridge

一个基于 Chrome Debugger 的浏览器扩展桥接工具。

它把扩展能力暴露给页面环境和 userscript，用一个可配置 token 作为桥接通道名，从而在页面里安全调用这些能力：

- 查找并点击元素
- 获取元素视口坐标并用 Chrome Debugger 坐标点击
- 填充输入框
- 逐键输入
- 等待元素出现
- 等待 URL 匹配
- 等待网络空闲
- 读写扩展存储
- 截取当前调用页面所在 active tab 的可见网页区域
- 清理指定 URL 或域名下的 Cookie

项目内已包含一个 `test.user.js` 示例，演示如何从 userscript 通过桥接调用扩展能力完成自动化登录和页面操作。

## 特性

- 基于 `chrome.debugger`，不依赖页面自行暴露 API
- content script 与页面脚本双桥接
- token 可在扩展设置页中修改
- 默认自动生成 32 位随机字符串 token
- 支持普通 DOM 点击、坐标点击、输入、逐键输入、等待类操作
- 支持 `chrome.storage.local` / `chrome.storage.sync` 的字符串读写
- 默认支持截取当前调用页面所在 active tab 的可见网页区域
- 支持按 URL、域名、名称清理 Cookie

## 安装扩展

1. 打开 Chrome 扩展管理页：`chrome://extensions/`
2. 开启“开发者模式”
3. 选择“加载已解压的扩展程序”
4. 选择本项目目录

## 设置 token

1. 打开扩展详情页
2. 进入“扩展选项”
3. 在设置页中查看或修改 `Bridge Token`
4. 保存后立即生效

说明：

- 默认会自动生成一个 32 位随机字符串
- token 实际保存在 `chrome.storage.local`
- 页面桥接会自动同步最新 token

## 桥接原理

页面环境中会注入：

```js
await window.ApliNiBrowserDebuggingExtension(token[, options])
```

其中：

- `ApliNiBrowserDebuggingExtension(token[, options])`：异步函数，只有在握手成功、确认已连接扩展后才会返回发送函数
- `token` 必填, 必须与扩展设置页中的 `Bridge Token` 完全一致
- `options.timeoutMs?: number`：初始化握手超时，默认 `3000`
- page-bridge 不再使用固定握手事件名
- 首次校验与正式通信都会直接使用 `token` 本身作为自定义事件名
- 只有知道正确 token 的可信脚本，才能与 `bridge.js` 建立隐蔽连接
- 初始化阶段如果出现任何问题，会直接抛错，不会返回不可用的 send 函数

最简调用：

```js
const send = await window.ApliNiBrowserDebuggingExtension('your-bridge-token');

const result = await send({ action: 'waitUrlMatch', pattern: /google\.com/ });

console.log(result);
```

userscript 示例：

```js
// ==UserScript==
// @name         autoext test loginGoogle
// @namespace    autoext
// @version      0.1.0
// @description  使用扩展 bridge 调用 loginGoogle 流程
// @match        *://*/*
// @grant        unsafeWindow
// ==/UserScript==

(async function () {
	'use strict';
	
	const BRIDGE_TOKEN = 'your-bridge-token';
	const debugSend = await unsafeWindow.ApliNiBrowserDebuggingExtension(BRIDGE_TOKEN);

	await debugSend({
		action: 'click',
		selector: 'button',
		selectorText: '下一步',
	});

})();
```

其中 `BRIDGE_TOKEN` 应当由可信脚本自行持有，并与扩展设置页中的值保持一致。

## 返回结果约定

成功时通常返回：

```js
{ ok: true, ...data }
```

失败时会抛出异常，错误文本通常包括：

- `Bridge access token is required`
- `Bridge access token mismatch`
- `Missing msg.action or msg.type`
- `Missing msg.selector`
- `Missing msg.pattern`
- `Target is not editable`
- `waitUrlMatch timeout ...`
- `waitNetworkIdle timeout ...`

## 所有功能与示例

下面按 `action` 分类列出所有可调用能力。兼容只传 `type` 的调用；如果 `action` 与 `type` 同时存在，优先使用 `action`。

---

### 1) `click`

点击目标元素。

参数：

- `selector: string | string[]` 必填
- `selectorText: string | string[]` 可选
- `waitElement?: boolean` 默认 `true`
- `intervalMs?: number` 默认 `200`
- `timeoutMs?: number` 默认 `30000`
- `waitAfterFoundMs?: number` 默认 `100`

示例 1：点击按钮

```js
await send({
  action: 'click',
  selector: 'button',
  selectorText: '登录',
});
```

示例 2：多个选择器里找匹配文字的元素

```js
await send({
  action: 'click',
  selector: ['button', 'a'],
  selectorText: ['Continue with Google', 'Google 登录', '使用 Google 继续'],
  timeoutMs: 10000,
});
```

示例 3：不等待元素，立即执行

```js
await send({
  action: 'click',
  selector: '#submit',
  waitElement: false,
});
```

---

### 2) `clickElementCoordinates`

按 `click` 相同规则定位元素，但底层会先获取元素在当前视口内的可点击坐标，再通过 Chrome Debugger 坐标点击。需要把普通 DOM 点击替换为真实坐标点击时，通常只要把原来的 `action: 'click'` 改成 `action: 'clickElementCoordinates'` 或 `type: 'clickElementCoordinates'`。

参数沿用 `click`：

- `selector: string | string[]` 必填
- `selectorText: string | string[]` 可选
- `waitElement?: boolean` 默认 `true`
- `intervalMs?: number` 默认 `200`
- `timeoutMs?: number` 默认 `30000`
- `waitAfterFoundMs?: number` 默认 `100`
- `button?: 'left' | 'middle' | 'right'` 默认 `left`
- `clickCount?: number` 正整数，默认 `1`

示例：由 `click` 替换为坐标点击

```js
await send({
  action: 'clickElementCoordinates',
  selector: 'button',
  selectorText: '登录',
  button: 'right',
});
```

---

### 3) `input`

直接给输入框、文本域、可编辑节点或下拉选择框赋值，并触发 `input` / `change` 事件。

支持元素类型：`input`、`textarea`、`contenteditable`、`select`。

`select` 匹配规则：优先按 `option.value` 精确匹配，其次按显示文本精确匹配（包含 `label` / `text`，会去除首尾空白）。找不到匹配项会失败；通过 `send()` 调用时会抛出异常。

`select multiple` 支持多选：`value` 传数组时选择多个选项，传字符串时选择单个选项；任一项找不到都会失败。单选 `select` 应传字符串，数组仅建议用于 `select multiple`。

参数：

- `selector: string | string[]` 必填
- `selectorText: string | string[]` 可选
- `value?: string | string[]`
- `waitElement?: boolean`
- `intervalMs?: number`
- `timeoutMs?: number`
- `waitAfterFoundMs?: number`

示例 1：填写邮箱

```js
await send({
  action: 'input',
  selector: 'input[type="email"]',
  value: 'user@example.com',
});
```

示例 2：填写密码并延后执行

```js
await send({
  action: 'input',
  selector: 'input[type="password"]',
  value: 'secret-pass',
  waitAfterFoundMs: 2000,
});
```

示例 3：给 contenteditable 节点赋值

```js
await send({
  action: 'input',
  selector: '[contenteditable="true"]',
  value: 'hello world',
});
```

示例 4：选择单选 select

```js
await send({
  action: 'input',
  selector: 'select[name="country"]',
  value: 'CN',
});
```

示例 5：选择多选 select

```js
await send({
  action: 'input',
  selector: 'select[multiple]',
  value: ['frontend', 'backend'],
});
```

---

### 4) `getElementCoordinates`

按现有 `selector` / `selectorText` 规则定位元素，滚动到视口中间，并返回元素在当前视口内的 CSS 像素坐标。顶层 `x` / `y` 会尽量取元素矩形与视口交集区域的中心点，确保坐标落在视口内，可直接作为 `clickCoordinates` 的输入；同时返回 `coordinates`、`rect`、`viewport` 和可直接点击的 `click` 对象。

参数：

- `selector: string | string[]` 必填
- `selectorText: string | string[]` 可选
- `waitElement?: boolean` 默认 `true`
- `intervalMs?: number` 默认 `200`
- `timeoutMs?: number` 默认 `30000`
- `waitAfterFoundMs?: number` 默认 `100`

成功返回示例：

```js
{
  ok: true,
  tabId: 123,
  attempts: 1,
  action: 'clickCoordinates',
  x: 320.5,
  y: 240,
  coordinates: { x: 320.5, y: 240 },
  rect: { left: 280, top: 220, right: 361, bottom: 260, width: 81, height: 40, x: 280, y: 220 },
  viewport: { width: 1280, height: 720, devicePixelRatio: 1, scrollX: 0, scrollY: 500 },
  click: { action: 'clickCoordinates', type: 'clickCoordinates', x: 320.5, y: 240 }
}
```

示例 1：获取按钮中心点

```js
const pos = await send({
  action: 'getElementCoordinates',
  selector: 'button',
  selectorText: '提交',
});

console.log(pos.x, pos.y);
```

示例 2：获取后直接真实鼠标点击

```js
const pos = await send({
  action: 'getElementCoordinates',
  selector: 'button',
  selectorText: '提交',
});

await send({ type: 'clickCoordinates', ...pos, button: 'right' });
```

---

### 5) `clickCoordinates`

使用 Chrome Debugger `Input.dispatchMouseEvent` 按视口 CSS 像素坐标模拟真实鼠标点击。事件序列包含 `mouseMoved`、`mousePressed`、`mouseReleased`。额外字段会被忽略，因此可接收 `getElementCoordinates` 的顶层 `x` / `y` 或 `coordinates.x` / `coordinates.y`。

参数：

- `x: number` 与 `y: number`，或 `coordinates: { x: number, y: number }`
- `button?: 'left' | 'middle' | 'right'` 默认 `left`
- `clickCount?: number` 正整数，默认 `1`

示例 1：点击指定坐标

```js
await send({
  action: 'clickCoordinates',
  x: 320.5,
  y: 240,
});
```

也可以用 `type` 调用，适合直接展开 `getElementCoordinates` 的返回值：

```js
const pos = await send({ action: 'getElementCoordinates', selector: 'button' });
await send({ type: 'clickCoordinates', ...pos, button: 'right' });
```

示例 2：用 `coordinates` 点击

```js
await send({
  action: 'clickCoordinates',
  coordinates: { x: 320.5, y: 240 },
});
```

示例 3：右键或双击

```js
await send({
  action: 'clickCoordinates',
  x: 320.5,
  y: 240,
  button: 'right',
});

await send({
  action: 'clickCoordinates',
  x: 320.5,
  y: 240,
  clickCount: 2,
});
```

---

### 6) `inputKey`

有非空 `selector` 时，默认先定位/等待/聚焦目标元素，再通过 debugger 模拟逐键输入，更接近真实键盘输入。无 `selector`、`selector: null`、空字符串或空数组时，不聚焦任何元素，直接向当前页面已有焦点/活动上下文输入。`select` 推荐使用 `action: 'input'` 直接选择选项，而不是逐键输入。

参数：

- `selector?: string | string[]`
- `selectorText: string | string[]` 可选
- `value?: string`
- `waitElement?: boolean`
- `intervalMs?: number`
- `timeoutMs?: number`
- `waitAfterFoundMs?: number`
- `perKeyDelayMs?: number` 每个字符之间的延迟，默认 `0`

示例 1：逐键输入名称

```js
await send({
  action: 'inputKey',
  selector: '#name',
  value: 'test',
});
```

示例 2：模拟慢速打字

```js
await send({
  action: 'inputKey',
  selector: 'textarea',
  value: 'Hello from BrowserDebugBridge',
  perKeyDelayMs: 80,
});
```

示例 3：输入带换行的文本

```js
await send({
  action: 'inputKey',
  selector: 'textarea',
  value: 'line 1\nline 2',
});
```

示例 4：无 selector，直接向当前焦点输入

```js
await send({
  action: 'inputKey',
  value: 'type into active field',
});
```

`selector: null` 也会按无 selector 处理：

```js
await send({
  action: 'inputKey',
  selector: null,
  value: 'type into active field',
});
```

---

### 7) `pasteInput`

使用 Chrome Debugger `Input.insertText` 一次性插入文本，适合长文本输入或模拟粘贴。与 `inputKey` 的区别：`inputKey` 会逐键派发键盘事件，可配置每个字符延迟；`pasteInput` 不逐字符输入，而是把整段文本一次性插入到当前焦点/目标元素中。不会通过 DOM 直接改值。

聚焦规则与 `inputKey` 一致：有非空 `selector` 时，先按现有 `selector` / `selectorText` 逻辑等待并聚焦目标元素，然后插入文本；无 `selector`、`selector: null`、空字符串或空数组时，不聚焦任何元素，直接向当前页面已有焦点/活动上下文插入。

参数：

- `selector?: string | string[]`
- `selectorText?: string | string[]`
- `value?: string`
- `waitElement?: boolean`
- `intervalMs?: number`
- `timeoutMs?: number`
- `waitAfterFoundMs?: number`

示例 1：定位 textarea 后一次性插入长文本

```js
await send({
  action: 'pasteInput',
  selector: 'textarea[name="message"]',
  value: '这是一段较长文本\n会一次性插入到目标输入框。',
});
```

示例 2：无 selector，直接插入到当前焦点

```js
await send({
  action: 'pasteInput',
  value: 'paste into active field',
});
```

---

### 8) `waitForElement`

等待元素出现，并可额外校验元素文本是否匹配。

参数：

- `selector: string | string[]` 必填
- `selectorText: string | string[]` 可选
- `intervalMs?: number` 默认 `200`
- `timeoutMs?: number` 默认 `30000`

成功返回示例：

```js
{
  ok: true,
  tabId: 123,
  attempts: 4,
  candidates: 2,
}
```

示例 1：等待一个输入框出现

```js
await send({
  action: 'waitForElement',
  selector: 'input[type="password"]',
});
```

示例 2：等待按钮且文本匹配

```js
await send({
  action: 'waitForElement',
  selector: 'button',
  selectorText: '下一步',
  timeoutMs: 15000,
});
```

示例 3：多个选择器联合等待

```js
await send({
  action: 'waitForElement',
  selector: ['button', 'a'],
  selectorText: ['Create', '创建'],
});
```

---

### 9) `waitUrlMatch`

轮询当前 tab URL，直到匹配指定正则。

参数：

- `pattern: string | RegExp` 必填
- `flags?: string`
- `intervalMs?: number` 默认 `200`
- `timeoutMs?: number` 默认 `30000`

成功返回示例：

```js
{
  ok: true,
  tabId: 123,
  attempts: 6,
  url: 'https://accounts.google.com/v3/signin/challenge/pwd?...'
}
```

示例 1：传入正则对象

```js
await send({
  action: 'waitUrlMatch',
  pattern: /\/v3\/signin\/challenge\/pwd\?.*/,
});
```

示例 2：传入字符串正则

```js
await send({
  action: 'waitUrlMatch',
  pattern: '.*\\/settings\\/keys$',
});
```

示例 3：附加 flags

```js
await send({
  action: 'waitUrlMatch',
  pattern: 'openrouter',
  flags: 'i',
});
```

---

### 10) `waitNetworkIdle`

等待页面网络请求进入空闲状态。

参数：

- `idleMs?: number` 默认 `1000`
- `timeoutMs?: number` 默认 `30000`

成功返回示例：

```js
{
  ok: true,
  tabId: 123,
  pending: 0,
  idleFor: 1187,
}
```

示例 1：等待默认空闲

```js
await send({
  action: 'waitNetworkIdle',
});
```

示例 2：要求至少 2 秒无网络活动

```js
await send({
  action: 'waitNetworkIdle',
  idleMs: 2000,
  timeoutMs: 60000,
});
```

典型用法：

```js
await send({ action: 'click', selector: 'button', selectorText: '提交' });
await send({ action: 'waitNetworkIdle', idleMs: 1500 });
```

---

### 11) `kvGet`

读取扩展存储中的字符串。

参数：

- `key: string` 必填
- `area?: 'local' | 'sync'` 默认 `local`

返回示例：

```js
{
  ok: true,
  area: 'local',
  key: 'apiKey',
  value: 'abc123'
}
```

示例：

```js
const res = await send({
  action: 'kvGet',
  key: 'apiKey',
  area: 'local',
});

console.log(res.value);
```

---

### 12) `kvSet`

写入扩展存储中的字符串。

参数：

- `key: string` 必填
- `value: string` 必填
- `area?: 'local' | 'sync'` 默认 `local`

示例 1：写入本地存储

```js
await send({
  action: 'kvSet',
  key: 'apiKey',
  value: 'abc123',
  area: 'local',
});
```

示例 2：写入同步存储

```js
await send({
  action: 'kvSet',
  key: 'profile',
  value: 'default',
  area: 'sync',
});
```

---

### 13) `kvDel`

删除扩展存储中的键。

参数：

- `key: string` 必填
- `area?: 'local' | 'sync'` 默认 `local`

示例：

```js
await send({
  action: 'kvDel',
  key: 'apiKey',
  area: 'local',
});
```

---

### 14) `enableForegroundMask`

启用“伪前台模式”，让页面里的部分 JS 检测更接近标签页仍在前台时的表现。

参数：

- `maskVisibility?: boolean` 默认 `true`，伪装 `document.hidden` / `document.visibilityState`
- `maskFocus?: boolean` 默认 `true`，伪装 `document.hasFocus()`，并尽力启用 CDP 焦点模拟
- `maskEvents?: boolean` 默认 `true`，过滤 `visibilitychange` / `blur` 监听
- `maskRAF?: boolean` 默认 `true`，为 `requestAnimationFrame` 提供降级 fallback

成功返回示例：

```js
{
  ok: true,
  tabId: 123,
  enabled: true,
  config: {
    maskVisibility: true,
    maskFocus: true,
    maskEvents: true,
    maskRAF: true,
  },
  scriptId: '123.456',
  appliedAt: 1712222222222,
}
```

示例：

```js
await send({
  action: 'enableForegroundMask',
  maskVisibility: true,
  maskFocus: true,
  maskEvents: true,
  maskRAF: true,
});
```

说明：

- 该能力继续复用现有 token 桥接，不新增新的页面全局入口
- 会立即尝试补当前文档，并对后续新文档自动继续注入
- 这是“伪前台模式”，不是浏览器内核级真正前台
- 无法保证解除 Chrome 对后台标签页的所有节流策略

---

### 15) `disableForegroundMask`

关闭“伪前台模式”。

成功返回示例：

```js
{
  ok: true,
  tabId: 123,
  enabled: false,
  restoredCurrentDocument: true,
}
```

示例：

```js
await send({
  action: 'disableForegroundMask',
});
```

说明：

- 会停止后续新文档的自动注入
- 会尽力恢复当前文档，但不保证撤销所有已经发生过的副作用
- 如果目标页面行为复杂，最稳妥的完全恢复方式仍然是刷新页面

---

### 16) `getForegroundMaskState`

读取当前 tab 的“伪前台模式”状态。

返回示例：

```js
{
  ok: true,
  tabId: 123,
  enabled: true,
  config: {
    maskVisibility: true,
    maskFocus: true,
    maskEvents: true,
    maskRAF: true,
  },
  appliedAt: 1712222222222,
  scriptId: '123.456',
}
```

示例：

```js
const maskState = await send({
  action: 'getForegroundMaskState',
});

console.log(maskState);
```

---

### 17) `captureVisibleTab`

截取当前调用页面所在 active tab 的可见网页区域。

它截取的是当前标签页视口内实际可见的网页内容，不是：

- 整个网页全页截图
- 浏览器窗口 UI 截图
- 桌面截图
- 其他标签页截图

`captureVisibleTab` 默认可用，无需额外设置。

参数：

- `format?: 'png' | 'jpeg'` 默认 `png`
- `quality?: number` 取值 `1` 到 `100`，仅 `format: 'jpeg'` 时可用

返回示例：

```js
{
  ok: true,
  tabId: 123,
  windowId: 456,
  format: 'png',
  dataUrl: 'data:image/png;base64,...'
}
```

示例 1：截取 PNG

```js
const shot = await send({
  action: 'captureVisibleTab',
});

console.log(shot.dataUrl);
```

示例 2：截取 JPEG 并指定质量

```js
const shot = await send({
  action: 'captureVisibleTab',
  format: 'jpeg',
  quality: 80,
});

console.log(shot.dataUrl);
```

限制与安全注意事项：

- 只截取当前调用页面所在的 active tab 可见网页区域，不能用于全页截图
- 不包含浏览器地址栏、工具栏、扩展弹窗、系统窗口或桌面内容
- 如果页面未处于可截图状态、权限不足，或截图过程中切换了该窗口的 active tab，会抛出异常
- 返回值是 `dataUrl`，可能较大，调用方应避免无必要地持久化或外传
- 截图可能包含账号、验证码、个人资料等敏感信息，请只在可信页面和可信脚本中使用
- token 泄露会扩大截图能力的滥用风险，请妥善保管并定期更换

---

### 18) `clearCookies`

清理指定 `url` 或 `domain` 的 Cookie。

参数：

- `url?: string`
- `domain?: string | string[]`
- `names?: string[]`
- `storeId?: string`

说明：

- `url` 和 `domain` 至少传一个
- 只传 `url` 时，按该 URL 查询并删除匹配 Cookie
- 只传 `domain` 时，按该域名匹配并删除 Cookie；`domain` 传数组时可一次清理多个域名
- `domain` 数组必须非空，且每一项都必须是非空字符串
- `url` 和 `domain` 都传时，以 `url` 查询 Cookie，并用 `domain` 额外过滤；当 `domain` 是数组时，匹配任意一个域名即可
- `url` 仅支持 `http` / `https`
- `domain` 不做 eTLD+1 推导；传入什么域名就按该域名匹配，不会自动扩展到顶级可注册域
- `names` 可选；传入后只删除名称在列表内的 Cookie
- `storeId` 可选；用于指定 Cookie store
- 可以删除 HttpOnly Cookie
- 只清理 Cookie，不会清理 `localStorage` / `sessionStorage` / `IndexedDB`
- 这是高风险操作，会影响登录态；请只在明确目标范围内使用，不使用全局清理
- 返回结果会包含 `removed`、`failed`、`cookies`、`failures`；`ok: true` 不代表每个 Cookie 都删除成功，需关注 `failed` 和 `failures`

示例 1：按 URL 清理 Cookie

```js
await send({
  action: 'clearCookies',
  url: 'https://example.com/account',
});
```

示例 2：按多个 domain 清理 Cookie

```js
await send({
  action: 'clearCookies',
  domain: ['example.com', 'accounts.example.com'],
});
```

示例 3：按名称删除指定 Cookie

```js
await send({
  action: 'clearCookies',
  url: 'https://example.com/',
  names: ['sid', 'session'],
});
```

---

## 常见组合示例

### 示例 1：Google 登录流程

```js
await send({
  action: 'input',
  selector: 'input[type="email"]',
  value: 'user@example.com',
});

await send({
  action: 'click',
  selector: 'button',
  selectorText: '下一步',
});

await send({
  action: 'waitUrlMatch',
  pattern: /\/v3\/signin\/challenge\/pwd\?.*/,
});

await send({
  action: 'input',
  selector: 'input[type="password"]',
  value: 'secret-pass',
  waitAfterFoundMs: 2000,
});
```

### 示例 2：先确认元素已出现，再执行自定义逻辑

```js
const found = await send({
  action: 'waitForElement',
  selector: 'button',
  selectorText: 'Create',
});

console.log('按钮已出现，候选数:', found.candidates);

// 这里再决定是否继续执行别的动作
if (found.candidates > 0) {
  await send({ action: 'waitNetworkIdle', idleMs: 800 });
}
```

### 示例 3：点击后等待请求稳定

```js
await send({
  action: 'click',
  selector: '#submit',
});

await send({
  action: 'waitNetworkIdle',
  idleMs: 1500,
  timeoutMs: 30000,
});
```

### 示例 4：配置持久化

```js
await send({ action: 'kvSet', key: 'siteMode', value: 'prod' });

const config = await send({ action: 'kvGet', key: 'siteMode' });
console.log(config.value);

await send({ action: 'kvDel', key: 'siteMode' });
```

### 示例 5：先启用伪前台，再执行页面逻辑

```js
await send({
  action: 'enableForegroundMask',
  maskVisibility: true,
  maskFocus: true,
  maskEvents: true,
  maskRAF: true,
});

await send({
  action: 'click',
  selector: 'button',
  selectorText: '开始',
});

const state = await send({ action: 'getForegroundMaskState' });
console.log(state.enabled);
```

## 适用场景

- userscript 借助扩展能力执行受控自动化
- 登录流、按钮流、表单流自动化，支持填写 input、textarea、contenteditable 和 select
- 等待页面稳定后继续执行下一步
- 用扩展存储为脚本保存少量字符串配置
- 对只依赖基础可见性/焦点检测的页面做“伪前台”兼容
- 获取当前可见网页区域截图用于调试或记录
- 在明确目标范围内清理 Cookie，用于重置登录态或调试会话状态

## 伪前台模式的边界

- 能伪装的主要是页面 JS 可直接读取到的部分信号，例如：
  - `document.hidden`
  - `document.visibilityState`
  - `document.hasFocus()`
  - `visibilitychange` / `blur` 的部分监听
  - `requestAnimationFrame` 的降级 fallback
- 不能保证的包括：
  - 浏览器后台标签页的所有计时器节流都被解除
  - 页面真实渲染时序完全等价于前台
  - 所有站点或复杂框架都无法识别后台状态
  - 已经发生过的页面副作用可以被完整回滚

---

友链: https://linux.do/
