

### 目录

- 桥接
	- 初始化
	- 扩展内部事件
- 设置
	- 启动打开网页
- 点击
	- 点击元素
	- 获取元素坐标
	- 点击坐标
	- 点击元素坐标
- 鼠标
	- 圆形移动
- 输入
	- 直接输入
	- 逐键输入
	- 粘贴输入
- 等待
	- 等待元素
	- 等待 URL 匹配
	- 等待网络空闲
- 网络
	- 跨域 Fetch
- 页面
	- 获取页面文本
- 存储
	- 读取字符串
	- 写入字符串
	- 删除键
- 伪前台
	- 启用伪前台
	- 禁用伪前台
	- 读取伪前台状态
- 截图
	- 截取可见区域
- Cookie
	- 清理 Cookie
	- 清理站点数据
- 项目
	- 返回约定
	- 元素定位与 selectorText
	- 安全风险与边界



### 桥接.初始化 `ApliNiBrowserDebuggingExtension`

> 页面全局入口、token 握手、发送函数

页面环境中由 `page-bridge.js` 注入 `window.ApliNiBrowserDebuggingExtension(token, options)`。调用时必须传入与扩展本地存储一致的 token；函数会用 token 本身作为自定义事件名发起握手，握手成功后返回 `debug(payload)`。后续 `send` 会把 payload 通过同一个 token 事件转给 content bridge，再由后台执行。

相关/关联功能描述。
- 桥接.Token 管理
- 项目.返回约定

#### 输入

```json
{
	"token": "your-bridge-token",
	"options": {
		"timeoutMs": 3000
	}
}
```

#### 输出

```json
{
	"send": "function",
	"handshake": true,
	"cachedByToken": true
}
```

#### 示例

```js
const debug = await window.ApliNiBrowserDebuggingExtension('your-bridge-token', { timeoutMs: 3000 });

const result = await debug({
	action: 'waitUrlMatch',
	pattern: /example\.com/,
});

console.log(result);
```

#### 注意事项

- token 为空会抛出 `Bridge access token is required`。
- 握手超时或 token 不匹配会抛出 `Bridge access token mismatch`。
- 初始化超时最小 300 毫秒，握手阶段最大按 3000 毫秒限制。
- `waitUrlMatch` 的 RegExp 会在页面侧转换为字符串 `pattern` 与 `flags`。




### 桥接.扩展内部事件 `newEvent` / `listenEvent` / `awaitEvent`

> 同一扩展通信体系下的页面、标签、帧之间广播自定义事件

页面侧 `debug` 支持注册持续监听、等待下一次事件、广播事件与注销监听器。持续监听器的 `callback` 只保存在当前页面的 `page-bridge` 内，不会发送到后台；后台仅以内存态保存 `listenerId`、事件名以及监听者所在 tab/frame。

#### 示例

```js
const listenerId = await debug({
	action: 'listenEvent',
	name: 'job-done',
	callback: (data) => {
		console.log('job done:', data);
	},
});

await debug({
	action: 'newEvent',
	name: 'job-done',
	data: { id: 1, ok: true },
});

await debug({ action: 'removeEventListener', listenerId });
```

等待下一次事件会返回该事件的 `data`，可选 `timeoutMs`；超时会显式抛错。

```js
const data = await debug({
	action: 'awaitEvent',
	name: 'job-done',
	timeoutMs: 5000,
});
```

注销监听器支持以下 action 别名，并支持 `listenerId` 或 `id` 入参：

```js
await debug({ action: 'removeEventListener', listenerId });
await debug({ action: 'unlistenEvent', id: listenerId });
await debug({ action: 'removeEvent', listenerId });
```

#### 注意事项

- `name` 不能为空；`listenEvent.callback` 必须是函数；注销未知 `listenerId` 会抛错。
- 事件监听器是后台内存态注册：扩展后台重启、页面关闭/刷新、tab 关闭都会使监听器失效；tab 关闭时后台会清理该 tab 的所有事件监听器。
- 事件会广播给所有同名监听器；`newEvent` 返回 `{ ok, delivered, failed, failures }`。`delivered` 只统计页面侧确认存在对应 `listenerId` 且事件名匹配的投递；未知 `listenerId`、事件名不匹配、页面/帧不可达等会记录到 `failures`，后台会清理对应监听器，且不影响其他监听器。
- `listenEvent.callback` 异常不会使本次投递从 `delivered` 中扣除：只要页面侧存在对应监听器并确认处理，后台即视为已投递；异常会在页面控制台记录，并可在投递确认中作为 `callbackError` 附带给后台。
- `awaitEvent` 是一次性监听器，收到一次事件并确认投递后自动从后台注册表移除；超时从后台注册成功后开始计时，超时时页面会补偿请求后台删除监听器。
- 手动注销会先请求后台删除，后台成功后才删除页面本地监听状态；如果页面本地已无该 `listenerId`，仍会尝试通知后台删除，并通过返回值中的 `localHadListener` 表示本地是否存在。




### 设置.启动打开网页 `startupUrl`

> 浏览器启动、自动打开 URL、本地配置

扩展设置页可配置浏览器/profile 启动后自动打开的网页地址，支持每行一个 URL。配置保存在 `chrome.storage.local` 的 `apliNiBrowserDebuggingExtensionStartupUrl` 键中；当浏览器启动并触发扩展后台 `chrome.runtime.onStartup` 时，后台读取这些地址，忽略空行，等待 1000 毫秒后逐个通过 `chrome.tabs.create({ url })` 打开新标签页。

相关/关联功能描述。
- 桥接.初始化
- 存储.读取字符串
- 项目.安全风险与边界

#### 输入

```json
{
	"startupUrl": "https://example.com/dashboard\nhttps://example.org/report"
}
```

#### 输出

```json
{
	"behavior": "浏览器/profile 启动后等待约 1000ms 逐个打开配置 URL",
	"openedWhenStartupUrlExists": true,
	"urls": [
		"https://example.com/dashboard",
		"https://example.org/report"
	]
}
```

#### 示例

```js
await chrome.storage.local.set({
	apliNiBrowserDebuggingExtensionStartupUrl: 'https://example.com/dashboard\nhttps://example.org/report',
});

// 下次浏览器/profile 启动后，扩展等待约 1 秒并逐个打开这些 URL。
```

#### 注意事项

- 启动 URL 可在扩展设置页中填写，并通过“保存启动 URL”按钮独立保存；Token 通过 Token 卡片内按钮独立保存。
- Token 卡片中的“重新生成”只重新生成并保存 Token，不校验也不保存启动 URL。
- 在设置页按 `Ctrl/Cmd + S` 时，会根据当前焦点所在卡片保存对应配置；焦点在启动 URL 卡片内时保存启动 URL，否则保存 Token。
- URL 允许为空；为空或仅包含空行时启动后不打开任何网页。
- 支持多行配置，每行一个 URL；读取旧的单 URL 字符串仍按单行配置处理。
- 空行会被忽略；每个非空 URL 必须是合法 `http://` 或 `https://` 地址，其他协议不会打开，并会逐条在后台 `console.error` 记录错误。
- 启动后会逐个打开所有合法 URL；某个 URL 打开失败会在后台 `console.error` 记录，但不会阻断其他 URL。
- 打开新标签依赖现有 `tabs` 权限，配置读取依赖现有 `storage` 权限，不需要新增 manifest 权限。
- 该功能只在浏览器/profile 启动触发 `chrome.runtime.onStartup` 时执行，不表示扩展安装、更新或设置保存后立即打开。




### 标签页.打开新标签页 `openTab`

> Chrome Debugger、CDP Target.createTarget、隐身窗口、前台/后台打开

默认通过已附加到当前 tab 的 Chrome Debugger 会话调用 Chrome DevTools Protocol `Target.createTarget` 打开新标签页。该功能不是页面脚本 `window.open()`；`focus` 用于控制新标签页是否前台打开。传入 `incognito: true` 时改为使用 `chrome.windows.create({ url, incognito: true, focused: focus })` 打开隐身窗口。

相关/关联功能描述。
- 桥接.初始化
- 等待.等待 URL 匹配
- 项目.安全风险与边界

#### 输入

```json
{
	"action": "openTab",
	"type": "openTab",
	"url": "https://example.com/dashboard",
	"focus": false,
	"incognito": false
}
```

#### 输出

```json
{
	"ok": true,
	"tabId": 123,
	"sourceTabId": 123,
	"targetId": "ABCDEF1234567890",
	"createdTabId": 456
}
```

隐身模式打开时返回：

```json
{
	"ok": true,
	"incognito": true,
	"windowId": 789,
	"tabId": 123,
	"createdTabId": 456,
	"sourceTabId": 123
}
```

#### 示例

```js
// 后台打开，不切换到新标签页。
await debug({
	action: 'openTab',
	url: 'https://example.com/dashboard',
	focus: false,
});

// 前台打开，切换到新标签页。focus 省略时默认 true。
await debug({
	action: 'openTab',
	url: 'https://example.com/dashboard',
	focus: true,
});

// 打开隐身窗口。需要在扩展详情页启用“允许在隐身模式下运行”。
await debug({
	action: 'openTab',
	url: 'https://example.com/dashboard',
	incognito: true,
	focus: true,
});
```

#### 注意事项

- `url` 必填，且只允许合法 `http://` 或 `https://` 地址。
- `focus` 可省略，默认 `true`；传入时必须是布尔值。`focus: false` 会以 `Target.createTarget({ background: true })` 后台创建目标，通常不会切换到新标签页。
- `incognito` 可省略，默认 `false`；传入时必须是布尔值。
- 普通打开（`incognito` 为 `false`）需要当前/发送方 tab 作为调试命令发起目标；后台会先确保该 tab 已通过 `chrome.debugger.attach` 附加，再发送 `Target.createTarget`。
- 普通打开输出中的 `tabId` 与 `sourceTabId` 都表示发起 CDP 命令的当前/发送方 tab，不是新打开的标签页 ID。
- 普通打开返回的 `targetId` 是 CDP Target ID，不是 Chrome Extensions 的 `tabs.Tab.id`。后台会尽力通过 `chrome.debugger.getTargets()` 关联 `createdTabId`；如果浏览器未及时暴露关联信息，`createdTabId` 可能为 `null`，但不会影响新标签页创建结果。
- 隐身模式打开前会调用 `chrome.extension.isAllowedIncognitoAccess()` 检测用户授权状态；必须在扩展详情页开启“允许在隐身模式下运行”，否则会显式抛错。
- manifest 中的 `incognito: "split"` 不是授权开关，只声明用户允许隐身运行后普通与隐身使用相互隔离的扩展实例；只要没有设置 `incognito: "not_allowed"`，真正能否使用隐身能力仍由用户授权决定。
- 隐身模式打开输出包含 `incognito: true`、`windowId`、`createdTabId`（如果 Chrome 返回了新窗口内标签页信息）和 `sourceTabId`。`tabId` 与 `sourceTabId` 始终表示发起请求的当前/发送方 tab，`createdTabId` 表示新隐身窗口中的标签页 ID。
- 打开普通新标签页依赖现有 `debugger` 权限；打开隐身窗口使用 `chrome.windows.create`，当前扩展已有 `tabs` 权限，可读取返回窗口内标签页信息，不需要新增其他 manifest 权限。




### 点击.点击元素 `click`

> DOM 点击、选择器、文本匹配、等待元素

按元素定位规则查找目标元素：可传 `selector`、`selectorText`，也允许只传 `selectorText`。同时传入时先用 `selector` 收集候选，再用 `selectorText` 过滤，即 `selector` 优先；只传 `selectorText` 时在全 DOM 中查找文本并选择最小匹配元素。找到后滚动到视口中心，聚焦并调用 DOM `el.click()`。

相关/关联功能描述。
- 点击.点击元素坐标
- 等待.等待元素
- 输入.直接输入

#### 输入

```json
{
	"action": "click",
	"type": "click",
	"selector": {
		"AND": [".login-panel", "button"],
		"final": "button"
	},
	"selectorText": {
		"OR": ["登录", "Login"]
	},
	"waitElement": true,
	"intervalMs": 200,
	"timeoutMs": 30000,
	"waitAfterFoundMs": 100
}
```

#### 输出

```json
{
	"ok": true,
	"tabId": 123
}
```

#### 示例

```js
// 单 selector：点击第一个匹配 CSS 选择器的提交按钮。
await debug({
	action: 'click',
	selector: '#submit',
});

// 单 selectorText：在全 DOM 中查找包含“确认提交”的最小文本元素并点击。
await debug({
	action: 'click',
	selectorText: '确认提交',
});

// 数组 OR：在 button 或 a 候选中，点击文本为“登录”或“Login”的候选元素。
await debug({
	action: 'click',
	selector: ['button', 'a'],
	selectorText: ['登录', 'Login'],
	timeoutMs: 10000,
});

// selectorText.AND + final：先找同时包含“确认”和“提交”的最小文本容器，再点击容器内的“提交”。
await debug({
	action: 'click',
	selectorText: {
		AND: ['确认', '提交'],
		final: '提交',
	},
});

// selector.AND + final + selectorText 过滤：先定位弹窗内主按钮，再要求该候选容器内含“确认”和“提交”；最终目标仍是 button.primary。
await debug({
	action: 'click',
	selector: {
		AND: ['.dialog', 'button.primary'],
		final: 'button.primary',
	},
	selectorText: {
		AND: ['确认', '提交'],
	},
});
```

#### 注意事项

- `selector` 与 `selectorText` 至少传一个；`selector` / `selectorText` 支持字符串、字符串数组和对象表达式。旧数组写法保持 OR 语义兼容。
- 对象表达式支持 `AND`、`OR`、`final`；`selector.AND` 是最小容器语义，寻找自身或后代包含所有选择器条件的最小元素，优先不同元素，失败允许同一元素；`selectorText.AND` 同样是最小文本容器语义；`final` 只在前一步匹配结果内部查找，找不到则操作失败。
- 同时有 `selector` 和 `selectorText` 时，`selector` 先得到候选/容器，`selectorText` 作为过滤条件；`selectorText` 对象表达式只用于判断候选内部是否满足文本条件，不会把最终目标改成 `selectorText` 命中的后代。最终操作目标由 `selector` 或 `selector.final` 决定；若仅使用 `selectorText`，才由 `selectorText` 或 `selectorText.final` 决定最终目标。
- `selectorText` 是文本匹配，不是正则匹配；优先级为完全匹配 > trim 后完全匹配 > 包含。
- 只传 `selectorText` 时会遍历全 DOM，命中后选择包含匹配文本的最小元素，避免优先选中 `body` 等大容器。
- `afterFoundMs` 不受支持，应使用 `waitAfterFoundMs`。
- 普通 DOM 点击不等同于 Chrome Debugger 坐标点击。



### 点击.获取元素坐标 `getElementCoordinates`

> 元素视口坐标、可点击中心点、CSS 像素

按元素定位规则定位元素，滚动到视口中间，读取元素 `getBoundingClientRect()`，计算元素矩形与视口交集区域中心点并返回。可传 `selector`、`selectorText`，也允许只传 `selectorText`；顶层 `x`/`y`、`coordinates` 与 `click` 可直接用于 `clickCoordinates`。

相关/关联功能描述。
- 点击.点击坐标
- 点击.点击元素坐标
- 等待.等待元素

#### 输入

```json
{
	"action": "getElementCoordinates",
	"type": "getElementCoordinates",
	"selector": "button[type=submit]",
	"selectorText": "提交",
	"waitElement": true,
	"intervalMs": 200,
	"timeoutMs": 30000,
	"waitAfterFoundMs": 100
}
```

#### 输出

```json
{
	"ok": true,
	"tabId": 123,
	"attempts": 1,
	"action": "clickCoordinates",
	"x": 320.5,
	"y": 240,
	"coordinates": {
		"x": 320.5,
		"y": 240
	},
	"rect": {
		"x": 280,
		"y": 220,
		"left": 280,
		"top": 220,
		"right": 361,
		"bottom": 260,
		"width": 81,
		"height": 40
	},
	"viewport": {
		"width": 1280,
		"height": 720,
		"devicePixelRatio": 1,
		"scrollX": 0,
		"scrollY": 500
	},
	"click": {
		"action": "clickCoordinates",
		"type": "clickCoordinates",
		"x": 320.5,
		"y": 240
	},
	"candidates": 1
}
```

#### 示例

```js
const pos = await debug({
	action: 'getElementCoordinates',
	selector: 'button',
	selectorText: '提交',
});

const textPos = await debug({
	action: 'getElementCoordinates',
	selectorText: '提交',
});

await debug({
	action: 'clickCoordinates',
	x: pos.x,
	y: pos.y,
});
```

#### 注意事项

- 坐标是当前视口 CSS 像素，不是页面绝对坐标或屏幕坐标。
- `selector` 与 `selectorText` 至少传一个；只传 `selectorText` 时会全 DOM 查找并选择最小匹配元素。
- `selectorText` 匹配优先级为完全匹配 > trim 后完全匹配 > 包含，不支持正则。
- 目标元素无有效矩形或不在视口内会失败。
- 返回的 `action: "clickCoordinates"` 是便于链式点击的建议动作。
- 页面滚动、缩放或布局变化后坐标可能失效。



### 点击.点击坐标 `clickCoordinates`

> Chrome Debugger 鼠标事件、视口坐标、右键、双击

使用 `Input.dispatchMouseEvent` 按视口 CSS 像素坐标派发 `mouseMoved`、`mousePressed`、`mouseReleased`，支持左键、中键、右键和多次点击。可接收顶层 `x`/`y`，也可接收 `coordinates.x`/`coordinates.y`。

相关/关联功能描述。
- 点击.获取元素坐标
- 点击.点击元素坐标
- 鼠标.圆形移动

#### 输入

```json
{
	"action": "clickCoordinates",
	"type": "clickCoordinates",
	"x": 320.5,
	"y": 240,
	"coordinates": {
		"x": 320.5,
		"y": 240
	},
	"button": "left",
	"clickCount": 1
}
```

#### 输出

```json
{
	"ok": true,
	"tabId": 123,
	"x": 320.5,
	"y": 240,
	"button": "left",
	"clickCount": 1
}
```

#### 示例

```js
await debug({
	action: 'clickCoordinates',
	x: 320.5,
	y: 240,
});

await debug({
	type: 'clickCoordinates',
	coordinates: { x: 320.5, y: 240 },
	button: 'right',
});

await debug({
	action: 'clickCoordinates',
	x: 320.5,
	y: 240,
	clickCount: 2,
});
```

#### 注意事项

- `x` 与 `y` 必须是有限数字。
- `button` 只允许 `left`、`middle`、`right`。
- `clickCount` 必须是正整数。
- 坐标越界不会在参数归一化阶段被自动纠正。



### 点击.点击元素坐标 `clickElementCoordinates`

> 先定位元素、再坐标点击、Debugger 点击

按元素定位规则定位元素并计算可点击坐标，再调用 `clickCoordinates` 的底层逻辑执行 Chrome Debugger 坐标点击。可传 `selector`、`selectorText`，也允许只传 `selectorText`。适用于页面对普通 DOM `click()` 不响应、需要更接近真实鼠标点击的场景。

相关/关联功能描述。
- 点击.点击元素
- 点击.获取元素坐标
- 点击.点击坐标

#### 输入

```json
{
	"action": "clickElementCoordinates",
	"type": "clickElementCoordinates",
	"selector": "button",
	"selectorText": "登录",
	"waitElement": true,
	"intervalMs": 200,
	"timeoutMs": 30000,
	"waitAfterFoundMs": 100,
	"button": "left",
	"clickCount": 1
}
```

#### 输出

```json
{
	"ok": true,
	"tabId": 123,
	"attempts": 1,
	"x": 320.5,
	"y": 240,
	"button": "left",
	"clickCount": 1,
	"coordinates": {
		"x": 320.5,
		"y": 240,
		"button": "left",
		"clickCount": 1
	},
	"element": {
		"ok": true,
		"action": "clickCoordinates",
		"x": 320.5,
		"y": 240,
		"coordinates": {
			"x": 320.5,
			"y": 240
		},
		"rect": {
			"x": 280,
			"y": 220,
			"left": 280,
			"top": 220,
			"right": 361,
			"bottom": 260,
			"width": 81,
			"height": 40
		},
		"viewport": {
			"width": 1280,
			"height": 720,
			"devicePixelRatio": 1,
			"scrollX": 0,
			"scrollY": 500
		},
		"click": {
			"action": "clickCoordinates",
			"type": "clickCoordinates",
			"x": 320.5,
			"y": 240
		},
		"candidates": 1
	}
}
```

#### 示例

```js
await debug({
	action: 'clickElementCoordinates',
	selector: ['button', 'a'],
	selectorText: ['登录', 'Login'],
	button: 'left',
	clickCount: 1,
});

await debug({
	action: 'clickElementCoordinates',
	selectorText: '确认',
});
```

#### 注意事项

- 定位阶段与 `getElementCoordinates` 一样可能因元素不存在、文本不匹配、无可点击矩形而失败。
- `selector` 与 `selectorText` 至少传一个；只传 `selectorText` 时会全 DOM 查找并选择最小匹配元素。
- `selectorText` 匹配优先级为完全匹配 > trim 后完全匹配 > 包含，不支持正则。
- 点击阶段与 `clickCoordinates` 一样依赖 Chrome Debugger。
- 返回中的 `coordinates` 是带有 button/clickCount 的归一化点击参数。
- 页面布局变化可能导致定位后点击前坐标含义改变。



### 鼠标.圆形移动 `moveMouseCircle`

> 真实鼠标移动事件、视口中心、圆形轨迹

使用 `Input.dispatchMouseEvent` 在当前视口内派发多次 `mouseMoved`。轨迹以视口中心为圆心，半径约为视口短边的 45%，可配置持续时间、圈数、轨迹点数、抖动、方向和起始角度，不执行点击。

相关/关联功能描述。
- 点击.点击坐标
- 点击.点击元素坐标

#### 输入

```json
{
	"action": "moveMouseCircle",
	"type": "moveMouseCircle",
	"durationMs": 1200,
	"revolutions": 1,
	"steps": 100,
	"jitterPx": 1.25,
	"clockwise": true,
	"startAngleDeg": -90
}
```

#### 输出

```json
{
	"ok": true,
	"tabId": 123,
	"center": {
		"x": 640,
		"y": 360
	},
	"radius": 324,
	"points": 100,
	"elapsedMs": 1210,
	"durationMs": 1200,
	"steps": 100,
	"revolutions": 1,
	"clockwise": true,
	"startAngleDeg": -90,
	"jitterPx": 1.25,
	"requestedJitterPx": 1.25,
	"viewport": {
		"width": 1280,
		"height": 720,
		"devicePixelRatio": 1,
		"scrollX": 0,
		"scrollY": 0
	}
}
```

#### 示例

```js
await debug({ action: 'moveMouseCircle' });

await debug({
	action: 'moveMouseCircle',
	durationMs: 3000,
	revolutions: 2,
	steps: 180,
	clockwise: false,
	jitterPx: 0,
	startAngleDeg: 0,
});
```

#### 注意事项

- `durationMs` 必须大于 0 且不超过 60000。
- `revolutions` 必须大于 0 且不超过 20。
- `steps` 必须是 12 到 5000 的整数。
- 执行期间不会重新计算因滚动、缩放或视口变化造成的新轨迹。



### 输入.直接输入 `input`

> DOM 赋值、input、textarea、contenteditable、select

按元素定位规则定位目标元素后直接修改值，并派发 `input` 与 `change` 事件。支持 `HTMLInputElement`、`HTMLTextAreaElement`、`HTMLSelectElement` 与 `contenteditable`。`selector` 与 `selectorText` 可二选一；只传 `selectorText` 时在全 DOM 中查找并选择最小匹配元素。`select` 优先按 option.value 精确匹配，其次按 option label/text 精确匹配；多选 select 可传数组。

相关/关联功能描述。
- 输入.逐键输入
- 输入.粘贴输入
- 点击.点击元素

#### 输入

```json
{
	"action": "input",
	"type": "input",
	"selector": "input[name=email]",
	"selectorText": null,
	"value": "user@example.com",
	"waitElement": true,
	"intervalMs": 200,
	"timeoutMs": 30000,
	"waitAfterFoundMs": 100
}
```

#### 输出

```json
{
	"ok": true,
	"tabId": 123
}
```

#### 示例

```js
await debug({
	action: 'input',
	selector: 'input[type="email"]',
	value: 'user@example.com',
});

await debug({
	action: 'input',
	selector: '[contenteditable="true"]',
	value: 'hello world',
});

await debug({
	action: 'input',
	selector: 'select[name="country"]',
	value: 'CN',
});

await debug({
	action: 'input',
	selector: 'select[multiple]',
	value: ['frontend', 'backend'],
});

await debug({
	action: 'input',
	selectorText: '邮箱',
	value: 'user@example.com',
});
```

#### 注意事项

- `selector` 与 `selectorText` 至少传一个；`selectorText` 匹配优先级为完全匹配 > trim 后完全匹配 > 包含。
- 只传 `selectorText` 时会全 DOM 查找并选择最小匹配元素；目标不是 input、textarea、select 或 contenteditable 时会失败。
- 单选 select 建议传字符串，多选 select 可传字符串或数组。
- select 找不到任一目标选项会失败。
- 这是 DOM 直接赋值，不是键盘事件输入。



### 输入.逐键输入 `inputKey`

> Chrome Debugger 键盘事件、逐字符输入、可选聚焦

有非空 `selector` 或 `selectorText` 时，先按元素定位规则等待并聚焦目标元素，再通过 `Input.dispatchKeyEvent` 逐字符输入。只传 `selectorText` 时会全 DOM 查找并选择最小匹配元素后聚焦；`selector` 与 `selectorText` 都不传、`selector: null`、空字符串或空数组且无 `selectorText` 时，不主动聚焦，直接向当前页面已有焦点输入。可设置每个字符之间的延迟。

相关/关联功能描述。
- 输入.直接输入
- 输入.粘贴输入

#### 输入

```json
{
	"action": "inputKey",
	"type": "inputKey",
	"selector": "textarea",
	"selectorText": null,
	"value": "line 1\nline 2",
	"waitElement": true,
	"intervalMs": 200,
	"timeoutMs": 30000,
	"waitAfterFoundMs": 100,
	"perKeyDelayMs": 80
}
```

#### 输出

```json
{
	"ok": true,
	"tabId": 123
}
```

#### 示例

```js
await debug({
	action: 'inputKey',
	selector: '#name',
	value: 'test',
});

await debug({
	action: 'inputKey',
	selector: 'textarea',
	value: 'line 1\nline 2',
	perKeyDelayMs: 80,
});

await debug({
	action: 'inputKey',
	selector: null,
	value: 'type into active field',
});

await debug({
	action: 'inputKey',
	selectorText: '搜索',
	value: 'keyword',
});
```

#### 注意事项

- `value` 会被转成字符串；空值会按空字符串处理。
- 支持常见字母、数字、空格、换行、Tab 和其他字符的输入路径。
- `selector` 或 `selectorText` 存在时会先定位聚焦；目标必须可编辑或可选择，否则聚焦阶段会失败。
- `selectorText` 匹配优先级为完全匹配 > trim 后完全匹配 > 包含；只传 `selectorText` 时会全 DOM 查找并选择最小匹配元素。
- `selector` 与 `selectorText` 都不传时，仍向当前页面已有焦点输入。
- `select` 选择选项更推荐使用 `input`。



### 输入.粘贴输入 `pasteInput`

> Input.insertText、一次性插入、长文本

有非空 `selector` 或 `selectorText` 时先按元素定位规则等待并聚焦目标元素，然后通过 Chrome Debugger `Input.insertText` 一次性插入整段文本。只传 `selectorText` 时会全 DOM 查找并选择最小匹配元素后聚焦；`selector` 与 `selectorText` 都不传时直接插入到当前焦点。与 `inputKey` 不同，它不逐字符派发键盘事件。

相关/关联功能描述。
- 输入.逐键输入
- 输入.直接输入

#### 输入

```json
{
	"action": "pasteInput",
	"type": "pasteInput",
	"selector": "textarea[name=message]",
	"selectorText": null,
	"value": "这是一段较长文本\n会一次性插入。",
	"waitElement": true,
	"intervalMs": 200,
	"timeoutMs": 30000,
	"waitAfterFoundMs": 100
}
```

#### 输出

```json
{
	"ok": true,
	"tabId": 123
}
```

#### 示例

```js
await debug({
	action: 'pasteInput',
	selector: 'textarea[name="message"]',
	value: '这是一段较长文本\n会一次性插入到目标输入框。',
});

await debug({
	action: 'pasteInput',
	value: 'paste into active field',
});

await debug({
	action: 'pasteInput',
	selectorText: '备注',
	value: 'paste into field found by text',
});
```

#### 注意事项

- `pasteInput` 不修改剪贴板，而是调用 `Input.insertText`。
- `selector` 或 `selectorText` 存在时聚焦规则与 `inputKey` 一致；两者都不传时仍向当前页面已有焦点输入。
- `selectorText` 匹配优先级为完全匹配 > trim 后完全匹配 > 包含；只传 `selectorText` 时会全 DOM 查找并选择最小匹配元素。
- 目标不可编辑时聚焦阶段会失败。
- 不支持 `perKeyDelayMs`，因为不是逐键输入。



### 等待.等待元素 `waitForElement`

> 轮询 DOM、选择器、文本匹配

通过 Chrome Debugger 在页面内轮询元素是否出现。`selector` 支持字符串或字符串数组，`selectorText` 支持字符串或字符串数组；两者可组合使用，也允许只传 `selectorText`。只传 `selectorText` 时在全 DOM 中查找文本并选择最小匹配元素。成功时返回尝试次数和候选元素数量。

相关/关联功能描述。
- 点击.点击元素
- 输入.直接输入
- 点击.获取元素坐标

#### 输入

```json
{
	"action": "waitForElement",
	"type": "waitForElement",
	"selector": ["button", "a"],
	"selectorText": ["创建", "Create"],
	"intervalMs": 200,
	"timeoutMs": 30000
}
```

#### 输出

```json
{
	"ok": true,
	"tabId": 123,
	"attempts": 4,
	"candidates": 2
}
```

#### 示例

```js
await debug({
	action: 'waitForElement',
	selector: 'input[type="password"]',
});

await debug({
	action: 'waitForElement',
	selector: ['button', 'a'],
	selectorText: ['Create', '创建'],
	timeoutMs: 15000,
});

await debug({
	action: 'waitForElement',
	selectorText: '加载完成',
	timeoutMs: 15000,
});
```

#### 注意事项

- `selector` 与 `selectorText` 至少传一个。
- 超时会抛出包含 `timeout waiting for element` 的错误。
- `selectorText` 匹配优先级为完全匹配 > trim 后完全匹配 > 包含，不支持正则。
- 只传 `selectorText` 时会全 DOM 查找并选择最小匹配元素，候选数量表示当前定位规则下的候选规模。
- 轮询间隔默认为 200 毫秒。



### 等待.等待 URL 匹配 `waitUrlMatch`

> 轮询 tab URL、正则字符串、flags

轮询当前调用 tab 的 URL，直到 URL 匹配指定正则。页面侧 `send` 会把 RegExp 对象转换为 `pattern` 字符串和 `flags`；也可直接传字符串正则。

相关/关联功能描述。
- 桥接.初始化
- 等待.等待网络空闲

#### 输入

```json
{
	"action": "waitUrlMatch",
	"type": "waitUrlMatch",
	"pattern": ".*\\/settings\\/keys$",
	"flags": "i",
	"intervalMs": 200,
	"timeoutMs": 30000
}
```

#### 输出

```json
{
	"ok": true,
	"tabId": 123,
	"attempts": 6,
	"url": "https://example.com/settings/keys"
}
```

#### 示例

```js
await debug({
	action: 'waitUrlMatch',
	pattern: /\/settings\/keys$/,
});

await debug({
	action: 'waitUrlMatch',
	pattern: 'openrouter',
	flags: 'i',
	timeoutMs: 10000,
});
```

#### 注意事项

- `pattern` 必填，必须是字符串或页面侧可转换的 RegExp。
- 无效正则会失败。
- 超时错误包含 `waitUrlMatch timeout`。
- 调用方应确保页面侧请求超时大于后台等待超时加上余量。



### 等待.等待网络空闲 `waitNetworkIdle`

> Network.enable、pending 请求、空闲时间

通过 Chrome Debugger 启用 Network 事件跟踪，记录 pending 请求集合和最近网络活动时间。直到 pending 为 0 且连续空闲时间达到 `idleMs` 时返回。

相关/关联功能描述。
- 等待.等待 URL 匹配
- 点击.点击元素

#### 输入

```json
{
	"action": "waitNetworkIdle",
	"type": "waitNetworkIdle",
	"idleMs": 1000,
	"timeoutMs": 30000
}
```

#### 输出

```json
{
	"ok": true,
	"tabId": 123,
	"pending": 0,
	"idleFor": 1187
}
```

#### 示例

```js
await debug({ action: 'click', selector: '#submit' });

await debug({
	action: 'waitNetworkIdle',
	idleMs: 1500,
	timeoutMs: 30000,
});
```

#### 注意事项

- 该功能依赖 Chrome Debugger 与 Network 域。
- 网络长连接或持续请求可能导致超时。
- 轮询判断定时器间隔为 100 毫秒。
- `timeoutMs` 默认为 30000 毫秒。



### 网络.跨域 Fetch `fetch`

> 跨域请求、background fetch、Response 重建、二进制 body

通过 `debug.fetch(input, init)` 在页面侧发起跨域 fetch；也可以调用 `debug({ action: 'fetch', url/input, init })`，两种方式都返回页面可用的 `Response`。真实网络请求由扩展 background 执行，page-bridge 接收结构化结果后重建 `Response`，用于绕过页面自身 CORS 限制并保留标准 fetch 的使用体验。`action: 'fetch'` 与 `type: 'fetch'` 都会被 page-bridge 归一化为内部 fetch 请求。manifest 已要求 Chrome 148+，以使用扩展消息的 structured clone 能力传输请求与响应数据。

相关/关联功能描述。
- 桥接.初始化
- 项目.返回约定
- 项目.安全风险与边界

#### 输入

```json
{
	"action": "fetch",
	"url": "https://api.example.com/data",
	"input": "https://api.example.com/data",
	"init": {
		"method": "POST",
		"headers": {
			"content-type": "application/json"
		},
		"body": "{\"hello\":\"world\"}",
		"redirect": "follow"
	}
}
```

#### 输出

```json
{
	"response": "Response",
	"status": 200,
	"statusText": "OK",
	"headers": {
		"content-type": "application/json"
	},
	"body": "ArrayBuffer",
	"url": "https://api.example.com/data",
	"redirected": false,
	"type": "basic"
}
```

#### 示例

```js
const response = await debug.fetch('https://api.example.com/data');
console.log(response.status, await response.json());

const postResponse = await debug.fetch('https://api.example.com/upload', {
	method: 'POST',
	headers: { 'content-type': 'application/json' },
	body: JSON.stringify({ hello: 'world' }),
});
console.log(postResponse.ok, await postResponse.text());

const form = new FormData();
form.append('file', new File(['hello'], 'hello.txt', { type: 'text/plain' }));

const uploadResponse = await debug.fetch('https://api.example.com/files', {
	method: 'POST',
	body: form,
});
console.log(uploadResponse.status);

const streamResponse = await debug({
	action: 'fetch',
	input: 'https://api.example.com/stream-source',
	init: {
		method: 'POST',
		body: new ReadableStream({
			start(controller) {
				controller.enqueue(new TextEncoder().encode('streamed body'));
				controller.close();
			},
		}),
	},
});
console.log(streamResponse instanceof Response, await streamResponse.arrayBuffer());
```

#### 注意事项

- `debug.fetch(input, init)` 是推荐用法；`debug({ action: 'fetch', url/input, init })` 与其等价，也返回重建后的 `Response`。
- 兼容字段 `type: 'fetch'` 也会被 page-bridge 归一化，但新代码建议使用 `action: 'fetch'`。
- `request` 是 page-bridge 内部序列化字段，外部调用不要传 `request`；应使用 `debug.fetch(input, init)` 或 `debug({ action: 'fetch', url/input, init })`。
- `url` 或 `input` 必须能表示请求地址；同时传入时按实现归一化后的请求输入为准。
- 请求 body 支持 `string`、`URLSearchParams`、`Blob`、`File`、`FormData`、`ArrayBuffer`、`TypedArray`、`DataView`、`ReadableStream` 等；`ReadableStream` 会先 buffered 后再发送到 background。
- 传输请求体与响应体优先使用 structured clone / `ArrayBuffer`，避免 base64 编码带来的体积膨胀。
- 不对响应体大小设置额外限制，也不在功能层额外限制 URL 协议；实际可用性仍受浏览器、扩展权限、宿主环境和目标服务限制。
- HTTP `4xx`/`5xx` 与标准 fetch 一样不会 reject；只有网络错误、请求/响应序列化错误、结构化克隆失败等异常会 reject。
- `204`、`205`、`304` 响应按无 body 处理。
- 重建 `Response` 时 `url`、`redirected`、`type` 是 best-effort 补充字段，不应作为强一致安全判断依据。
- 该能力依赖 manifest 要求的 Chrome 148+ 对扩展消息 structured clone 的支持；不同 Chrome 版本对可克隆对象、流、`Blob`/`File` 元数据等支持存在限制。
- 这是高风险跨域能力：可访问页面脚本原本受 CORS 限制的数据，也可能携带敏感请求头或上传敏感内容。仅应在可信页面、可信 token 与明确授权的自动化流程中使用。



### 页面.获取页面文本 `getPageText`

> DOM 文本提取、选择器范围、当前快照、隐私风险

从当前调用 tab 的页面 DOM 中提取可捕获文本。默认提取整个当前 DOM 快照；传入 `selector`、`selectorText` 时按完整元素定位规则限定提取范围，支持字符串、字符串数组和对象表达式（`AND` / `OR` / `final`），同时传入时先按 `selector` 收集候选，再按 `selectorText` 过滤。提取结果按 DOM 顺序拼接，默认包含所有可捕获 DOM 文本、属性文本与表单内容。

相关/关联功能描述。
- 项目.元素定位与 selectorText
- 项目.安全风险与边界
- 项目.返回约定

#### 输入

```json
{
	"action": "getPageText",
	"type": "getPageText",
	"selector": {
		"AND": ["main", "form"],
		"final": "form"
	},
	"selectorText": {
		"OR": ["登录", "Login"]
	},
	"includeIframes": true,
	"filterVisibility": false,
	"extraAttributes": ["data-title", "class"],
	"timeoutMs": 10000
}
```

#### 输出

```json
{
	"ok": true,
	"tabId": 123,
	"text": "页面中提取到的文本...",
	"length": 12,
	"truncated": false,
	"timeout": false,
	"sourceCounts": {
		"title": 1,
		"textNode": 8,
		"formValue": 2,
		"imageAlt": 1,
		"attributeText": 3,
		"placeholder": 1,
		"extraAttribute": 2
	},
	"candidates": 1,
	"textCandidates": 1
}
```

`candidates`、`textCandidates` 只在使用定位范围时用于诊断候选规模，具体是否出现取决于本次定位输入与实现可用信息。

#### 示例

```js
// 提取当前页面可捕获的全部 DOM 文本。
const pageText = await debug({ action: 'getPageText' });
console.log(pageText.text, pageText.length);

// 只提取 main 区域中的文本。
const mainText = await debug({
	action: 'getPageText',
	selector: 'main',
});

// 使用 selectorText 定位最小文本范围后提取。
const loginText = await debug({
	action: 'getPageText',
	selectorText: '登录',
	timeoutMs: 10000,
});

// selector + selectorText 组合：先限定候选，再按文本过滤。
const formText = await debug({
	action: 'getPageText',
	selector: 'form.login',
	selectorText: { OR: ['登录', 'Login'] },
});

// 额外提取指定属性。节点内容在前，属性在后。
const customAttributeText = await debug({
	action: 'getPageText',
	selector: '.card',
	extraAttributes: ['data-title', 'class'],
});

// 只提取当前可见/可访问的文本。默认不启用该过滤。
const visibleText = await debug({
	action: 'getPageText',
	filterVisibility: true,
});
```

#### 文本拼接规则

`getPageText` 使用稳定的节点块格式输出，避免调用方基于固定文本匹配时因属性与内容混排而失效。

- 遍历顺序为 DOM 顺序。
- 块级/控件/图片/带属性节点会形成稳定文本块；纯 inline 子树会尽量合并在同一内容块中，避免 `A<span>B</span>C` 被拆成多段。
- 没有内容也没有属性的节点会被忽略，不产生空行。
- 同一节点内，节点内容永远在前，属性文本永远在后。
- 节点内容与属性文本之间使用一个换行分隔。
- 同一节点的多个属性文本之间使用一个空格分隔，并按默认属性列表顺序 + `extraAttributes` 传入顺序输出。
- 不同有效节点块之间使用两个换行分隔。
- `<br>` 会在所在内容块内产生单个换行。
- 文本节点内部换行按类似 `textContent` 的方式保留换行边界，并将 `\r\n` / `\r` 规范化为 `\n`；水平空白会折叠为单个空格，行首尾空白会被裁剪。

例如：

```html
<p title="属性">内容</p>
<p data-title="额外" class="card">第一行
第二行</p>
```

调用：

```js
await debug({
	action: 'getPageText',
	includeTitle: false,
	extraAttributes: ['data-title', 'class'],
});
```

输出 `text`：

```txt
内容
属性

第一行
第二行
额外 card
```

#### 注意事项

- `timeoutMs` 可选，默认 `10000` 毫秒；超时的真实语义是返回已收集到的部分结果，仍为 `ok: true`，并将 `timeout: true`、`truncated: true`。调用方应检查这两个字段，避免把部分结果误当完整页面文本。
- `selector` / `selectorText` 支持完整元素定位范围：字符串、字符串数组、`AND`、`OR`、`final`；只传 `selectorText` 时会全 DOM 查找并选择最小匹配元素作为提取范围。即使使用 `selector` / `selectorText` 限定了局部提取范围，默认仍会额外包含 `document.title`，只有显式传 `includeTitle: false` 才排除标题。
- 不支持 `maxChars`、`maxNodes` 等截断/节点数量限制参数；调用方不要依赖这些字段限制输出规模。
- `extraAttributes` 可选，必须是字符串数组；用于追加提取默认列表之外的属性，例如 `['data-title', 'class']`。重复属性会去重，非法属性名会抛错。显式传入的 `extraAttributes` 不受 `includeAttributeText: false` 影响，因此可用于关闭默认属性抓取但保留指定属性。
- `sourceCounts` 使用实现中的真实来源 key 统计已加入片段数量，常见 key 包括 `title`、`textNode`、`formValue`、`imageAlt`、`attributeText`、`placeholder`、`extraAttribute`、`labelText`、`optionText`、`inaccessibleFrame` 等；具体字段取决于页面内容与本次提取选项。
- 默认包含所有可捕获 DOM 文本、属性文本与表单内容，包括 `input[type="password"]`、`input[type="hidden"]` 等输入值；这可能泄露密码、token、隐藏字段、表单草稿和其他敏感信息。
- 默认包含 `placeholder`，即使控件已有当前值也会一并输出，目的是保留所有可捕获的面向用户提示文本。
- 可见性过滤默认关闭，因此会尽量输出完整 DOM 内容，包括当前被 dialog/modal 临时设置为 `inert` 或 `aria-hidden="true"` 的背景内容。
- 如需只提取当前可见/可访问内容，可传 `filterVisibility: true`，或等价传 `visibilityMode: 'visible'`。开启后会跳过常见隐藏元素及其子树，包括 `hidden`、`inert`、`aria-hidden="true"`、`display:none`、`visibility:hidden/collapse`、`content-visibility:hidden`；`aria-labelledby` / `aria-describedby` 引用文本和 associated labels 也会应用同样过滤。`input[type="hidden"]` 不会仅因为浏览器默认 `display:none` 被排除，除非元素本身也符合上述显式隐藏条件。
- 这是高隐私风险能力，仅应在可信页面、可信 token 与明确授权的自动化流程中使用；不要把返回文本发送给不可信服务或日志系统。
- 返回内容是调用时的当前 DOM 快照，不会持续监听后续 DOM 变化；动态渲染、异步加载或用户输入变化可能导致多次调用结果不同。
- 文本按 DOM 顺序收集和拼接，不代表页面视觉顺序、阅读顺序或可访问性树顺序。
- 该接口不是 OCR，不会识别图片、canvas、视频帧、PDF 渲染层或浏览器 UI 中的文字；只能提取页面脚本可访问的 DOM/属性/表单内容。
- 元素定位（`selector` / `selectorText` / `final` 的范围选择）只在当前文档 DOM 内执行，不进入 iframe/frame 或 shadowRoot；定位到范围后进行文本提取时，默认会尝试读取该范围内可访问的 iframe/frame 文档与 open shadowRoot。closed shadowRoot、跨源 iframe、跨源隔离页面等实际可捕获范围仍受浏览器、页面结构、扩展权限与 Debugger 执行上下文限制。




### 存储.读取字符串 `kvGet`

> chrome.storage、local、sync、字符串读取

从扩展存储读取指定 key 的字符串值。`area` 为 `sync` 时读取 `chrome.storage.sync`，其他值或缺省时读取 `chrome.storage.local`。只有真实存储值为字符串时才作为 `value` 返回，否则为缺省值。

相关/关联功能描述。
- 存储.写入字符串
- 存储.删除键

#### 输入

```json
{
	"action": "kvGet",
	"type": "kvGet",
	"key": "apiKey",
	"area": "local"
}
```

#### 输出

```json
{
	"ok": true,
	"area": "local",
	"key": "apiKey",
	"value": "abc123"
}
```

#### 示例

```js
const res = await debug({
	action: 'kvGet',
	key: 'apiKey',
	area: 'local',
});

console.log(res.value);
```

#### 注意事项

- `key` 必填。
- `area` 只有精确等于 `sync` 才使用同步存储。
- 该接口只按字符串读取；非字符串值会表现为未定义值。
- 未读取到字符串值时，调用方不应依赖 `value` 一定存在或为某个固定 JSON 值。



### 存储.写入字符串 `kvSet`

> chrome.storage、local、sync、字符串写入

向扩展存储写入指定 key 的字符串值。`value` 必须是字符串，否则后台会抛出 `kvSet only accepts string value`。

相关/关联功能描述。
- 存储.读取字符串
- 存储.删除键

#### 输入

```json
{
	"action": "kvSet",
	"type": "kvSet",
	"key": "apiKey",
	"value": "abc123",
	"area": "local"
}
```

#### 输出

```json
{
	"ok": true,
	"area": "local",
	"key": "apiKey"
}
```

#### 示例

```js
await debug({
	action: 'kvSet',
	key: 'apiKey',
	value: 'abc123',
	area: 'local',
});

await debug({
	action: 'kvSet',
	key: 'profile',
	value: 'default',
	area: 'sync',
});
```

#### 注意事项

- `key` 必填。
- `value` 必须是字符串。
- `area` 缺省为 `local`。
- 存储容量限制遵循 Chrome storage 自身限制。



### 存储.删除键 `kvDel`

> chrome.storage、删除 key、本地或同步

从扩展存储删除指定 key。`area` 规则与 `kvGet`/`kvSet` 相同。

相关/关联功能描述。
- 存储.读取字符串
- 存储.写入字符串

#### 输入

```json
{
	"action": "kvDel",
	"type": "kvDel",
	"key": "apiKey",
	"area": "local"
}
```

#### 输出

```json
{
	"ok": true,
	"area": "local",
	"key": "apiKey"
}
```

#### 示例

```js
await debug({
	action: 'kvDel',
	key: 'apiKey',
	area: 'local',
});
```

#### 注意事项

- `key` 必填。
- 删除不存在的 key 通常仍返回成功。
- `area` 缺省为 `local`。
- 删除 token 存储键可能触发桥接 token 重新生成。



### 伪前台.启用伪前台 `enableForegroundMask`

> 可见性伪装、焦点伪装、事件过滤、RAF fallback

对当前 tab 启用“伪前台模式”。后台通过 Page.addScriptToEvaluateOnNewDocument 为后续新文档注入脚本，并立即在当前文档执行。可伪装 `document.hidden`、`document.visibilityState`、`document.hasFocus()`，过滤部分 `visibilitychange`/`blur` 监听，并为 `requestAnimationFrame` 提供 fallback。

相关/关联功能描述。
- 伪前台.禁用伪前台
- 伪前台.读取伪前台状态
- 项目.安全风险与边界

#### 输入

```json
{
	"action": "enableForegroundMask",
	"type": "enableForegroundMask",
	"maskVisibility": true,
	"maskFocus": true,
	"maskEvents": true,
	"maskRAF": true
}
```

#### 输出

```json
{
	"ok": true,
	"tabId": 123,
	"enabled": true,
	"config": {
		"maskVisibility": true,
		"maskFocus": true,
		"maskEvents": true,
		"maskRAF": true
	},
	"scriptId": "123.456",
	"appliedAt": 1712222222222
}
```

#### 示例

```js
await debug({
	action: 'enableForegroundMask',
	maskVisibility: true,
	maskFocus: true,
	maskEvents: true,
	maskRAF: true,
});

const state = await debug({ action: 'getForegroundMaskState' });
console.log(state.enabled, state.config);
```

#### 注意事项

- 所有 mask 选项默认启用，只有显式传 `false` 才关闭单项。
- 这是页面 JS 层面的伪装，不是浏览器内核级真正前台。
- 不能保证解除所有后台标签页计时器节流。
- 当前文档恢复不保证撤销所有已发生副作用。



### 伪前台.禁用伪前台 `disableForegroundMask`

> 移除新文档脚本、恢复当前文档、关闭焦点模拟

关闭当前 tab 的伪前台状态。若存在新文档注入脚本，会调用 Page.removeScriptToEvaluateOnNewDocument 移除；并尽力在当前文档执行恢复逻辑，必要时关闭焦点模拟。

相关/关联功能描述。
- 伪前台.启用伪前台
- 伪前台.读取伪前台状态

#### 输入

```json
{
	"action": "disableForegroundMask",
	"type": "disableForegroundMask"
}
```

#### 输出

```json
{
	"ok": true,
	"tabId": 123,
	"enabled": false,
	"config": null,
	"appliedAt": null,
	"restoredCurrentDocument": true
}
```

#### 示例

```js
await debug({ action: 'disableForegroundMask' });

const state = await debug({ action: 'getForegroundMaskState' });
console.log(state.enabled);
```

#### 注意事项

- 从未启用过时也会返回成功，`restoredCurrentDocument` 为 false。
- 复杂页面上恢复可能不完整，刷新页面是更稳妥的完全恢复方式。
- 会停止后续新文档自动注入。
- 依赖 Chrome Debugger 与 Page 域。



### 伪前台.读取伪前台状态 `getForegroundMaskState`

> 当前 tab 状态、配置、脚本标识、应用时间

读取后台内存中记录的当前 tab 伪前台状态，返回是否启用、配置、应用时间与新文档脚本标识。

相关/关联功能描述。
- 伪前台.启用伪前台
- 伪前台.禁用伪前台

#### 输入

```json
{
	"action": "getForegroundMaskState",
	"type": "getForegroundMaskState"
}
```

#### 输出

```json
{
	"ok": true,
	"tabId": 123,
	"enabled": true,
	"config": {
		"maskVisibility": true,
		"maskFocus": true,
		"maskEvents": true,
		"maskRAF": true
	},
	"appliedAt": 1712222222222,
	"scriptId": "123.456"
}
```

#### 示例

```js
const maskState = await debug({
	action: 'getForegroundMaskState',
});

if (!maskState.enabled) {
	await debug({ action: 'enableForegroundMask' });
}
```

#### 注意事项

- 状态保存在后台 service worker 运行期内的内存 Map 中。
- Chrome Debugger detach 时会清理该 tab 的状态。
- 未启用时 `config`、`appliedAt`、`scriptId` 为 null。
- 读取状态本身不向页面注入或恢复脚本。



### 截图.截取可见区域 `captureVisibleTab`

> 当前 active tab、可见网页区域、dataUrl

截取当前调用页面所在窗口 active tab 的可见网页区域，返回 PNG 或 JPEG data URL。后台会拒绝传入 `tabId` 或 `windowId`，并在截图前后确认 sender tab 仍是该窗口 active tab。

相关/关联功能描述。
- 项目.安全风险与边界
- 桥接.初始化

#### 输入

```json
{
	"action": "captureVisibleTab",
	"type": "captureVisibleTab",
	"format": "png"
}
```

#### 输出

```json
{
	"ok": true,
	"tabId": 123,
	"windowId": 456,
	"format": "png",
	"dataUrl": "data:image/png;base64,..."
}
```

#### 示例

```js
const pngShot = await debug({
	action: 'captureVisibleTab',
});
console.log(pngShot.dataUrl);

const jpegShot = await debug({
	action: 'captureVisibleTab',
	format: 'jpeg',
	quality: 80,
});
console.log(jpegShot.dataUrl);
```

#### 注意事项

- 只支持 `format: 'png'` 或 `format: 'jpeg'`。
- `quality` 只允许在 JPEG 时使用，且必须是 1 到 100 的整数。
- 不接受调用方指定 `tabId` 或 `windowId`。
- 不是全页截图、浏览器 UI 截图或桌面截图；dataUrl 可能包含敏感信息。



### Cookie.清理 Cookie `clearCookies`

> URL 或域名范围、名称过滤、storeId、HttpOnly Cookie

清理指定 URL 或 domain 范围内的 Cookie。`url` 与 `domain` 至少传一个；只传 URL 时按 URL 查询；只传 domain 时按域名查询；两者都传时按 URL 查询并用 domain 额外过滤。可用 `names` 限定 Cookie 名称，可用 `storeId` 指定 Cookie store。

相关/关联功能描述。
- 项目.安全风险与边界
- 存储.删除键

#### 输入

```json
{
	"action": "clearCookies",
	"type": "clearCookies",
	"url": "https://example.com/account",
	"domain": ["example.com", "accounts.example.com"],
	"names": ["sid", "session"],
	"storeId": "0"
}
```

#### 输出

```json
{
	"ok": true,
	"scope": "url",
	"query": {
		"url": "https://example.com/account",
		"domain": ["example.com", "accounts.example.com"],
		"names": ["sid", "session"],
		"storeId": "0"
	},
	"removed": 1,
	"failed": 0,
	"cookies": [
		{
			"name": "sid",
			"domain": ".example.com",
			"path": "/",
			"secure": true,
			"storeId": "0",
			"partitionKey": null,
			"details": {
				"url": "https://example.com/",
				"name": "sid",
				"storeId": "0"
			}
		}
	],
	"failures": []
}
```

#### 示例

```js
await debug({
	action: 'clearCookies',
	url: 'https://example.com/account',
});

await debug({
	action: 'clearCookies',
	domain: ['example.com', 'accounts.example.com'],
});

await debug({
	action: 'clearCookies',
	url: 'https://example.com/',
	names: ['sid', 'session'],
	storeId: '0',
});
```

#### 注意事项

- `url` 仅支持 `http` 或 `https`。
- `domain` 数组必须非空，且每一项都是非空字符串。
- `names` 必须是字符串数组；传入后只删除名称匹配的 Cookie。
- `ok: true` 不代表每个 Cookie 都删除成功，应检查 `failed` 与 `failures`。
- 这是高风险操作，会影响登录态；不会清理 localStorage、sessionStorage 或 IndexedDB。



### Cookie.清理站点数据 `clearSiteData`

> 域名范围、http/https origin、Cookie 与打开标签发现、残留数据清理

清理一个或多个域名对应的网站数据。扩展使用 manifest `incognito: "split"`，普通窗口与隐身窗口分别运行在对应 profile 中；`clearSiteData` 只信任调用来源的 `sender.tab.incognito` 判断当前 profile，不接受消息体中的 `incognito` 参数。输入支持 `domain` 或 `domains`，值可以是字符串或字符串数组；只传 `aaa.com` 时，扩展会自动补充 `http://aaa.com` 与 `https://aaa.com` origin。后台会通过 `chrome.cookies.getAll({ domain })` 查找匹配 Cookie，从 `cookie.domain` 提取 host，识别输入域名及其子域，并为这些 host 继续补充 `http://host` 与 `https://host` origins。同时会通过 `chrome.tabs.query({})` 查找当前打开的 `http/https` 页面，若页面 host 匹配输入域名或其子域，且 tab 的 `incognito` 与调用来源 profile 一致，则把该页面真实 `URL.origin` 加入 origins，因此可覆盖带端口 origin，例如 `https://api.aaa.com:8443`。

执行顺序为：先规范化 domains；通过 Cookie 与打开 tabs 发现 hosts/origins；对匹配 tabs 尝试用 debugger 在页面上下文执行 `sessionStorage.clear()` 与 `localStorage.clear()`；如果存在匹配 tab，再通过 Chrome DevTools Protocol 的 `Storage.clearDataForOrigin` 对已发现 origins 额外执行一层 `storageTypes: "all"` 清理；再使用 `chrome.browsingData.remove` 清理 `cache`、`cacheStorage`、`cookies`、`fileSystems`、`indexedDB`、`localStorage`、`serviceWorkers`、`webSQL`；最后重新查询目标 domains 的剩余 Cookie，并通过 Cookies API 逐个删除，尽量处理 `storeId`、`partitionKey` 等 Cookie 维度；默认以 `bypassCache: true` 重载匹配 tabs，避免旧运行态继续写回。不会使用 `chrome.storage` 清理网站数据，也不会清理扩展自身 storage。

相关/关联功能描述。
- Cookie.清理 Cookie
- 项目.安全风险与边界

#### 输入

```json
{
	"action": "clearSiteData",
	"domain": "aaa.com",
	"domains": ["aaa.com", "bbb.com"],
	"reloadTabs": true,
	"clearSessionStorage": true
}
```

#### 输出

```json
{
	"ok": true,
	"domains": ["aaa.com", "bbb.com"],
	"discoveredHosts": ["aaa.com", "api.aaa.com", "bbb.com"],
	"origins": ["http://aaa.com", "https://aaa.com", "http://api.aaa.com", "https://api.aaa.com", "https://api.aaa.com:8443", "http://bbb.com", "https://bbb.com"],
	"originSources": [
		{ "source": "domain", "domain": "aaa.com", "origins": ["http://aaa.com", "https://aaa.com"] },
		{ "source": "cookie", "host": "api.aaa.com", "origins": ["http://api.aaa.com", "https://api.aaa.com"] },
		{ "source": "tab", "tabId": 123, "url": "https://api.aaa.com:8443/app", "origin": "https://api.aaa.com:8443", "incognito": true }
	],
	"browsingData": {
		"ok": true,
		"error": null,
		"dataTypes": ["cache", "cacheStorage", "cookies", "fileSystems", "indexedDB", "localStorage", "serviceWorkers", "webSQL"]
	},
	"debuggerStorage": {
		"attempted": 5,
		"skipped": false,
		"driverTabId": 123,
		"driverIncognito": true,
		"reason": null,
		"cleared": 5,
		"failures": []
	},
	"cookies": {
		"matched": 2,
		"removed": 2,
		"failed": 0,
		"cookies": [
			{ "name": "sid", "domain": ".aaa.com", "path": "/", "secure": true }
		],
		"failures": []
	},
	"tabs": {
		"matched": 1,
		"reloaded": 1,
		"reloadFailures": [],
		"storageCleared": 1,
		"storageFailures": [],
		"debuggerDetached": [123],
		"debuggerDetachFailures": [],
		"items": [
			{ "tabId": 123, "url": "https://api.aaa.com:8443/app", "origin": "https://api.aaa.com:8443", "incognito": true }
		]
	},
	"limitations": [
		"Cookie domains and currently open tabs are used to discover subdomains. Unknown subdomains without matching cookies or open tabs cannot be enumerated by Chrome extension APIs.",
		"Only http and https origins derived from the input domains, discovered cookie domains, and matching open tab URL origins are cleared.",
		"Chrome extension APIs do not guarantee clearing HSTS, site permissions, media licenses, Shared Storage, Interest Groups, Storage Buckets, or other browser-internal site data. When a matching tab exists, Chrome DevTools Protocol Storage.clearDataForOrigin is also attempted as an extra best-effort cleanup layer."
	],
	"diagnostic": {
		"manifestIncognito": "split",
		"senderProfile": {
			"senderTabId": 123,
			"senderWindowId": 7,
			"senderIncognito": true
		},
		"tabProfileFilter": {
			"applied": true,
			"incognito": true
		},
		"requestedOptions": {
			"domains": ["aaa.com", "bbb.com"],
			"storeId": null,
			"reloadTabs": true,
			"clearSessionStorage": true
		}
	}
}
```

#### 示例

```js
await debug({
	action: 'clearSiteData',
	domains: ['aaa.com', 'bbb.com'],
});

await debug({
	action: 'clearSiteData',
	domain: 'aaa.com',
	reloadTabs: false,
});
```

#### 注意事项

- `domain` / `domains` 必须是裸域名，不允许包含协议、端口、路径、用户名密码等 URL 内容。
- 不允许单段 TLD 输入，例如 `com`。当前不内置 public suffix / 多租户域名 denylist，以保证调用方可以完整清理传入域名及通过 Cookie 发现的子域；调用方应只传入自己确实希望清理的域名范围。
- `reloadTabs` 可选，默认 `true`；设为 `false` 时不重载匹配 tabs。重载失败会记录在 `tabs.reloadFailures`，不影响前面的 browsingData 与 Cookie 兜底删除。
- `clearSessionStorage` 可选，默认 `true`；设为 `false` 时不尝试页面运行态 `sessionStorage.clear()` / `localStorage.clear()`。执行依赖 debugger attach，失败会记录在 `tabs.storageFailures`，不阻断主清理流程。
- 隐身模式使用 manifest `incognito: "split"`。后台只根据 Chrome 提供的 `sender.tab.incognito` 确定调用 profile，并在打开 tabs 发现、页面 storage 清理、debugger driver tab 与重载时过滤 `tab.incognito` 必须一致；无法获得 `sender.tab.incognito` 时会拒绝执行，避免跨普通/隐身 profile 清理运行态 tabs。
- `debuggerStorage` 是额外的最佳努力清理层；只有存在匹配 tab 时才能通过 debugger 调用 `Storage.clearDataForOrigin`。没有匹配 tab 时会返回 `debuggerStorage.skipped: true`、`driverTabId: null`、`driverIncognito: null` 和 `reason`，不记为失败。调用过程中临时 attach 的 debugger 会在清理结束后主动 detach，detach 失败记录在 `tabs.debuggerDetachFailures`。
- 自动补充 `http` 与 `https` origins，但不会补充未知协议；打开标签发现会使用页面真实 origin，可包含端口。
- 子域发现依赖 Cookie 与当前打开 tabs；没有匹配 Cookie、没有打开 tab 且未显式输入的未知子域无法自动发现。
- `storeId` 仍仅影响 Cookies API 的查询和逐个删除，不限制 `chrome.browsingData.remove` 的清理范围，也不用于选择普通/隐身 profile。
- `browsingData.ok: false` 时应检查 `browsingData.error`；即使 `browsingData` 失败，Cookie 兜底删除仍会继续执行。此时顶层 `ok` 为 `false`，但会保留 `browsingData` 与 `cookies` 明细。
- 顶层 `ok` 表示核心 `browsingData.remove` 与 Cookie 兜底删除均未报告失败；tab 运行态清理、重载和 debugger detach 属于最佳努力增强步骤，不影响顶层 `ok`，应分别检查 `tabs.storageFailures`、`tabs.reloadFailures` 与 `tabs.debuggerDetachFailures`。
- 扩展 API 不保证清理 HSTS、site permissions、media licenses、Shared Storage、Interest Groups、Storage Buckets 等浏览器内部站点数据。



### 项目.返回约定 `commonResult`

> 通用返回、ok、tabId、错误处理

后台动作成功时通常返回包含 `ok: true` 的对象；作用于当前调用 tab 的动作通常同时返回 `tabId`。不同功能会按需附加坐标、候选数量、尝试次数、状态、截图 dataUrl、Cookie 清理结果等字段。失败时不会伪装成成功结果，而是显式抛出错误，由调用方捕获处理。

相关/关联功能描述。
- 桥接.初始化
- 项目.元素定位与 selectorText
- 项目.安全风险与边界

#### 输入

```json
{
	"action": "click",
	"selectorText": "登录"
}
```

#### 输出

```json
{
	"ok": true,
	"tabId": 123
}
```

#### 示例

```js
try {
	const result = await debug({
		action: 'waitForElement',
		selectorText: '完成',
		timeoutMs: 10000,
	});

	console.log(result.ok, result.tabId, result.attempts);
} catch (error) {
	console.error('debug action failed:', error);
}
```

#### 注意事项

- `ok: true` 只表示当前动作完成，不代表后续页面状态一定符合业务预期。
- 元素类功能的 `candidates`、`attempts` 等字段用于诊断定位过程，不应替代业务断言。
- `selectorText` 只传文本时可能匹配多个元素，返回成功表示已按定位规则选中了其中最小匹配元素。
- 超时、参数非法、目标不可编辑、坐标无效、Debugger 调用失败等情况会抛出错误。



### 项目.元素定位与 selectorText `elementLocator`

> selectorText、全 DOM 查找、最小匹配元素、文本优先级

元素类功能统一使用元素定位规则。调用方可以传 `selector`、`selectorText`，也可以只传 `selectorText`。同时传入时先按 `selector` 收集候选元素，再按 `selectorText` 过滤，即 `selector` 优先；只传 `selectorText` 时会遍历全 DOM 文本并选择最小匹配元素，避免优先选中 `html`、`body` 或大型容器。

相关/关联功能描述。
- 点击.点击元素
- 输入.直接输入
- 等待.等待元素

#### 输入

```json
{
	"selector": {
		"AND": [".login-panel", "button"],
		"final": "button"
	},
	"selectorText": {
		"OR": ["登录", "Login"]
	},
	"waitElement": true,
	"intervalMs": 200,
	"timeoutMs": 30000,
	"waitAfterFoundMs": 100
}
```

#### 输出

```json
{
	"matched": true,
	"matchMode": "exact | trimmedExact | contains",
	"candidate": "smallest-matching-element"
}
```

#### 示例

```js
// 单 selector：点击第一个匹配 CSS 选择器的元素。
await debug({
	action: 'click',
	selector: 'button[type="submit"]',
});

// 单 selectorText：在全 DOM 中查找包含“登录”的最小文本元素并点击。
await debug({
	action: 'click',
	selectorText: '登录',
});

// 数组 OR：等待 button 或 a 任意一种元素出现。
await debug({
	action: 'waitForElement',
	selector: ['button', 'a'],
});

// 对象 OR：等待“保存”或“Save”任意一种文本出现。
await debug({
	action: 'waitForElement',
	selectorText: { OR: ['保存', 'Save'] },
});

// selectorText.AND 最小文本容器：点击同时包含“确认”和“删除”的最小文本容器。
await debug({
	action: 'click',
	selectorText: { AND: ['确认', '删除'] },
});

// selectorText.AND + final：先找同时包含两段文本的最小容器，再在容器内点击“删除”。
await debug({
	action: 'click',
	selectorText: {
		AND: ['确认', '删除'],
		final: '删除',
	},
});

// selector.AND 最小元素容器：点击同时包含弹窗和主按钮的最小元素容器。
await debug({
	action: 'click',
	selector: { AND: ['.modal', 'button.primary'] },
});

// selector.AND + final：先找同时包含弹窗和主按钮的最小容器，再在容器内点击主按钮。
await debug({
	action: 'click',
	selector: {
		AND: ['.modal', 'button.primary'],
		final: 'button.primary',
	},
});

// selector.AND 内嵌 OR + final：先找包含登录表单以及 input 或 button 的最小容器，再点击提交按钮。
await debug({
	action: 'click',
	selector: {
		AND: ['form.login', { OR: ['input', 'button'] }],
		final: 'button[type="submit"]',
	},
});

// selector + selectorText 过滤组合：selectorText 只过滤 selector 候选；最终输入目标仍是 input[name="email"]。
await debug({
	action: 'input',
	selector: 'input[name="email"]',
	selectorText: '邮箱',
	value: 'user@example.com',
});
```

#### 注意事项

- 适用的元素类功能包括 `click`、`input`、`inputKey`、`pasteInput`、`waitForElement`，以及复用相同定位规则的元素坐标相关功能。
- `selector` / `selectorText` 支持字符串、字符串数组和对象表达式。旧数组写法保持 OR 语义兼容，例如 `["button", "a"]` 等价于 `{ "OR": ["button", "a"] }`。
- 对象表达式支持 `AND`、`OR`、`final`：`OR` 表示任意条件命中即可；`AND` 表示所有条件都必须在同一个最小容器内命中。
- `selector.AND` 是最小容器语义：寻找自身或后代包含所有选择器条件的最小元素，优先让不同条件命中不同元素；如果无法拆分到不同元素，允许同一元素同时满足多个条件。
- `selectorText.AND` 同样是最小文本容器语义：寻找自身或后代包含所有文本条件的最小元素。
- `final` 只在前一步 `AND` / `OR` 的匹配结果内部继续查找最终目标；找不到则本次操作失败，不会回退到全 DOM 或其他候选。
- 同时有 `selector` 和 `selectorText` 时先按 `selector` 得到候选/容器，再用 `selectorText` 过滤候选，即 `selector` 优先；此时 `selectorText` 对象表达式只用于判断候选内部是否满足文本条件，不会把最终目标改成 `selectorText` 命中的后代。
- 最终操作目标由 `selector` 或 `selector.final` 决定；若仅使用 `selectorText`，才由 `selectorText` 或 `selectorText.final` 决定最终目标。
- `selectorText` 文本来源包括元素的 `innerText`、`textContent`、`value`、`aria-label`、`title`、`placeholder`。
- 文本匹配优先级固定为完全匹配 > trim 后完全匹配 > 包含；同一优先级内再按最小匹配元素选择目标。
- `selectorText` 不是正则表达式；需要精确限制范围时建议同时传 `selector`。



### 项目.安全风险与边界 `securityBoundary`

> 当前 tab、Debugger、DOM 操作、权限边界

扩展动作只针对发起调用的当前 tab 执行，不接受调用方随意指定其他 tab。元素类功能会在页面 DOM 中执行查找、聚焦、点击或输入；只传 `selectorText` 时会进行全 DOM 文本查找并选择最小匹配元素，但仍可能受页面结构、隐藏文本、重复文案、动态渲染影响。

相关/关联功能描述。
- 项目.返回约定
- 项目.元素定位与 selectorText
- 截图.截取可见区域

#### 输入

```json
{
	"action": "pasteInput",
	"selectorText": "备注",
	"value": "text"
}
```

#### 输出

```json
{
	"ok": true,
	"tabId": 123
}
```

#### 示例

```js
await debug({
	action: 'waitForElement',
	selectorText: '危险操作',
	timeoutMs: 5000,
});

await debug({
	action: 'click',
	selector: 'button.danger',
	selectorText: '确认删除',
});
```

#### 注意事项

- 只传 `selectorText` 会扩大查找范围；在重复文案较多或高风险操作中，建议同时传 `selector` 缩小候选范围。
- `inputKey` 与 `pasteInput` 在 `selector` 或 `selectorText` 存在时会先定位并聚焦；两者都不传时仍向当前页面已有焦点输入，调用前应确认焦点安全。
- DOM 点击、DOM 赋值、Debugger 坐标点击、键盘事件输入的效果不同，应按页面交互需求选择功能。
- 截图、Cookie 清理、伪前台等功能可能涉及敏感数据或页面状态变更，调用方应在可信上下文中使用。
